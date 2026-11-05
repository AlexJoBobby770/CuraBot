#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ESP32Servo.h>
#include <stdlib.h>
#include <string.h>

struct RouteStep {
  char action; // F = forward, B = backward, R = right, L = left
};

// =====================================================
// CURABOT+ - ENCODER NAVIGATION + HC-SR04 OBSTACLE GUARD + RFID MEDICINE COMPARTMENT + HTTP CONTROL
// =====================================================

// ---------- Wi-Fi Credentials ----------
const char* WIFI_SSID = "Alex Jo";
const char* WIFI_PASSWORD = "18052005";

WebServer server(80);

// ---------- L298N MOTOR DRIVER ----------
#define ENA 25
#define IN1 26
#define IN2 27
#define ENB 14
#define IN3 12
#define IN4 13

// ---------- VERIFIED PHYSICAL ENCODER MAPPING ----------
// Physical LEFT motor  -> GPIO 18/19
// Physical RIGHT motor -> GPIO 32/33
#define LEFT_A  18
#define LEFT_B  19
#define RIGHT_A 32
#define RIGHT_B 33

// ---------- HC-SR04 ULTRASONIC SENSOR ----------
#define TRIG_PIN 4
#define ECHO_PIN 35

// ---------- RFID (RC522) + MEDICINE COMPARTMENT SERVO ----------
// RC522 uses SPI: SCK=22, MISO=21, MOSI=23, SS/SDA=5, RST=16.
// IRQ is intentionally not connected.
#define RFID_SS_PIN   5
#define RFID_RST_PIN  16
#define RFID_SCK_PIN  22
#define RFID_MISO_PIN 21
#define RFID_MOSI_PIN 23
#define SERVO_PIN     17  // TX2 / GPIO17

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Servo medicineServo;

const int LID_CLOSED_ANGLE = 30;
const int LID_OPEN_ANGLE = 90;
const int SERVO_STEP_DELAY_MS = 25;
int currentServoAngle = LID_CLOSED_ANGLE;

// ---------- OBSTACLE THRESHOLDS (HYSTERESIS) ----------
const float OBSTACLE_STOP_THRESHOLD_CM  = 20.0f; // <= 20cm triggers obstacle stop
const float OBSTACLE_CLEAR_THRESHOLD_CM = 25.0f; // >= 25cm required to resume

volatile float currentDistanceCm = -1.0f;
volatile bool obstacleDetected = false;

// ---------- CALIBRATION: PRESERVED FROM YOUR TEST ----------
const float COUNTS_PER_CM = 140.0;
const float TRACK_WIDTH_CM = 14.0;
const float DISTANCE_CM = 40.0;

const int BASE_PWM = 90;
const int MIN_PWM = 70;
const int MAX_PWM = 120;
const int TURN_PWM = 90;
const float KP = 0.7;

const unsigned long MOVE_TIMEOUT = 15000;
const unsigned long TURN_TIMEOUT = 8000;

// ---------- ENCODERS ----------
volatile long leftCount = 0;
volatile long rightCount = 0;
volatile uint8_t prevLeft = 0;
volatile uint8_t prevRight = 0;

const int8_t encoderTable[16] = {
   0, -1,  1,  0,
   1,  0,  0, -1,
  -1,  0,  0,  1,
   0,  1, -1,  0
};

// ---------- ROBOT / COMMAND STATE ----------
enum RobotState : uint8_t {
  STATE_IDLE,
  STATE_MOVING,
  STATE_RETURNING,
  STATE_OBSTACLE,
  STATE_STOPPED,
  STATE_ERROR
};

volatile RobotState robotState = STATE_IDLE;
volatile bool stopRequested = false;
volatile bool navigationRunning = false;

char lastCommand[20] = "BOOT";
char lastDestination[32] = "RECEPTION";
uint32_t commandCount = 0;

RouteStep savedRoute[8];
uint8_t savedRouteLength = 0;
bool hasSavedRoute = false;
bool atBase = true; // becomes false after dispatch; true only after a completed return

// A delivery becomes eligible for RFID access only after its route completes.
volatile bool deliveryComplete = false;
volatile bool lidOpen = false;
byte openingCardUID[4] = {0, 0, 0, 0};
char accessStatus[32] = "WAITING_FOR_DELIVERY";

// Provisional card-to-destination mapping, based on the order the four UIDs were scanned.
const byte RFID_UID_WARD_A[4] = {0x1A, 0x2A, 0xDD, 0x35};
const byte RFID_UID_WARD_B[4] = {0xF6, 0x50, 0x2B, 0x07};
const byte RFID_UID_PHARMACY[4] = {0x5C, 0x32, 0x24, 0x07};
const byte RFID_UID_EMERGENCY[4] = {0x2A, 0xD2, 0xF7, 0x55};

// ---------- ROUTE DEFINITIONS ----------
// Demo map assumption (40 cm between points):
// Ward A:          F
// Ward B:          F -> R -> F
// Pharmacy:        F -> R -> F -> R -> F
// Emergency Room:  F -> L -> F
// Return uses the exact inverse sequence in reverse order.
const RouteStep ROUTE_WARD_A[] = {{'F'}};
const RouteStep ROUTE_WARD_B[] = {{'F'}, {'R'}, {'F'}};
const RouteStep ROUTE_PHARMACY[] = {{'F'}, {'R'}, {'F'}, {'R'}, {'F'}};
const RouteStep ROUTE_EMERGENCY[] = {{'F'}, {'L'}, {'F'}};

// =====================================================
// ULTRASONIC SENSOR MEASUREMENT
// =====================================================
float readUltrasonicDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  // 25 ms timeout (~4.3 meters max)
  long duration = pulseIn(ECHO_PIN, HIGH, 25000);
  if (duration <= 0) {
    return -1.0f; // No echo or out of range
  }
  float distance = (duration * 0.0343f) / 2.0f;
  return distance;
}

// =====================================================
// ENCODER INTERRUPTS
// =====================================================
void IRAM_ATTR leftEncoderISR() {
  uint8_t current = (digitalRead(LEFT_A) << 1) | digitalRead(LEFT_B);
  uint8_t transition = (prevLeft << 2) | current;
  leftCount += encoderTable[transition];
  prevLeft = current;
}

void IRAM_ATTR rightEncoderISR() {
  uint8_t current = (digitalRead(RIGHT_A) << 1) | digitalRead(RIGHT_B);
  uint8_t transition = (prevRight << 2) | current;
  rightCount += encoderTable[transition];
  prevRight = current;
}

void resetEncoders() {
  noInterrupts();
  leftCount = 0;
  rightCount = 0;
  prevLeft = (digitalRead(LEFT_A) << 1) | digitalRead(LEFT_B);
  prevRight = (digitalRead(RIGHT_A) << 1) | digitalRead(RIGHT_B);
  interrupts();
}

void readEncoders(long &left, long &right) {
  noInterrupts();
  left = leftCount;
  right = rightCount;
  interrupts();
}

// =====================================================
// MOTOR CONTROL
// =====================================================
void stopMotors() {
  analogWrite(ENA, 0);
  analogWrite(ENB, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void setLeftForward() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
}

void setLeftBackward() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
}

void setRightForward() {
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);
}

void setRightBackward() {
  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);
}

void setMotorPWM(int leftPWM, int rightPWM) {
  analogWrite(ENA, constrain(leftPWM, 0, 255));
  analogWrite(ENB, constrain(rightPWM, 0, 255));
}

// =====================================================
// STRAIGHT MOVEMENT - ENCODER SPEED-CORRECTION + OBSTACLE GUARD
// =====================================================
bool moveDistance(float distanceCM, bool backwards) {
  long target = (long)(distanceCM * COUNTS_PER_CM);

  Serial.printf("\n%s %.1f CM\n", backwards ? "MOVING BACKWARD:" : "MOVING FORWARD:", distanceCM);

  resetEncoders();

  if (backwards) {
    setLeftBackward();
    setRightBackward();
  } else {
    setLeftForward();
    setRightForward();
  }

  setMotorPWM(BASE_PWM, BASE_PWM);

  unsigned long startTime = millis();
  unsigned long lastUpdate = millis();
  unsigned long lastSensorCheck = 0;
  long previousLeft = 0;
  long previousRight = 0;
  bool leftFinished = false;
  bool rightFinished = false;

  while (!leftFinished || !rightFinished) {
    if (stopRequested) {
      stopMotors();
      obstacleDetected = false;
      return false;
    }

    // ── Ultrasonic Obstacle Check (Forward travel only) ──
    if (!backwards && (millis() - lastSensorCheck >= 80)) {
      lastSensorCheck = millis();
      float dist = readUltrasonicDistanceCm();
      if (dist > 0) {
        currentDistanceCm = dist;
      }

      if (dist > 0 && dist <= OBSTACLE_STOP_THRESHOLD_CM) {
        // Confirmation reading
        delay(10);
        float confirmDist = readUltrasonicDistanceCm();
        if (confirmDist > 0) currentDistanceCm = confirmDist;

        if (confirmDist > 0 && confirmDist <= OBSTACLE_STOP_THRESHOLD_CM) {
          Serial.printf("OBSTACLE DETECTED at %.1f cm! Pausing motors.\n", currentDistanceCm);
          stopMotors();
          obstacleDetected = true;
          RobotState savedState = robotState;
          robotState = STATE_OBSTACLE;

          unsigned long pauseStartTime = millis();
          int clearConsecutiveCount = 0;

          // Pause loop: Wait until obstacle clears or emergency STOP requested
          while (!stopRequested) {
            delay(100);
            float waitDist = readUltrasonicDistanceCm();
            if (waitDist > 0) currentDistanceCm = waitDist;

            if (waitDist >= OBSTACLE_CLEAR_THRESHOLD_CM) {
              clearConsecutiveCount++;
              if (clearConsecutiveCount >= 3) {
                Serial.printf("Obstacle cleared (%.1f cm). Resuming navigation.\n", waitDist);
                break;
              }
            } else {
              clearConsecutiveCount = 0;
            }
          }

          unsigned long pauseDuration = millis() - pauseStartTime;
          // Exclude paused time from movement timeout
          startTime += pauseDuration;
          lastUpdate = millis();

          if (stopRequested) {
            stopMotors();
            obstacleDetected = false;
            return false;
          }

          // Resume movement
          obstacleDetected = false;
          robotState = savedState;
          setLeftForward();
          setRightForward();
          setMotorPWM(BASE_PWM, BASE_PWM);
        }
      }
    }

    long left, right;
    readEncoders(left, right);
    long leftProgress = labs(left);
    long rightProgress = labs(right);

    if (leftProgress >= target && !leftFinished) {
      analogWrite(ENA, 0);
      leftFinished = true;
      Serial.println("Left wheel reached target");
    }

    if (rightProgress >= target && !rightFinished) {
      analogWrite(ENB, 0);
      rightFinished = true;
      Serial.println("Right wheel reached target");
    }

    if (millis() - lastUpdate >= 50) {
      long leftDelta = leftProgress - previousLeft;
      long rightDelta = rightProgress - previousRight;
      previousLeft = leftProgress;
      previousRight = rightProgress;
      lastUpdate = millis();

      if (!leftFinished && !rightFinished) {
        float error = leftDelta - rightDelta;
        int correction = (int)(KP * error);
        int leftPWM = constrain(BASE_PWM - correction, MIN_PWM, MAX_PWM);
        int rightPWM = constrain(BASE_PWM + correction, MIN_PWM, MAX_PWM);
        setMotorPWM(leftPWM, rightPWM);
      }
    }

    if (millis() - startTime > MOVE_TIMEOUT) {
      Serial.println("STRAIGHT MOVEMENT TIMEOUT!");
      stopMotors();
      obstacleDetected = false;
      return false;
    }
    delay(2);
  }

  stopMotors();
  obstacleDetected = false;
  long finalLeft, finalRight;
  readEncoders(finalLeft, finalRight);
  Serial.printf("Straight result - left: %ld, right: %ld\n", finalLeft, finalRight);
  return true;
}

bool moveForward(float distanceCM) {
  return moveDistance(distanceCM, false);
}

bool moveBackward(float distanceCM) {
  return moveDistance(distanceCM, true);
}

// =====================================================
// PIVOT TURNS - ENCODER-BASED GEOMETRY
// =====================================================
bool turnPivot(bool rightTurn) {
  float turnDistance = PI * TRACK_WIDTH_CM / 4.0;
  long target = (long)(turnDistance * COUNTS_PER_CM);

  Serial.printf("\nPIVOT %s 90 DEGREES, target=%ld\n", rightTurn ? "RIGHT" : "LEFT", target);
  resetEncoders();

  if (rightTurn) {
    setLeftForward();
    setRightBackward();
  } else {
    setLeftBackward();
    setRightForward();
  }

  setMotorPWM(TURN_PWM, TURN_PWM);
  unsigned long startTime = millis();

  while (true) {
    if (stopRequested) {
      stopMotors();
      return false;
    }

    long left, right;
    readEncoders(left, right);
    long leftProgress = labs(left);
    long rightProgress = labs(right);

    if (leftProgress >= target) analogWrite(ENA, 0);
    if (rightProgress >= target) analogWrite(ENB, 0);

    if (leftProgress >= target && rightProgress >= target) break;

    if (millis() - startTime > TURN_TIMEOUT) {
      Serial.println("TURN TIMEOUT!");
      stopMotors();
      return false;
    }
    delay(2);
  }

  stopMotors();
  long finalLeft, finalRight;
  readEncoders(finalLeft, finalRight);
  Serial.printf("Turn result - left: %ld, right: %ld\n", finalLeft, finalRight);
  return true;
}

bool turnRight90() { return turnPivot(true); }
bool turnLeft90()  { return turnPivot(false); }

// =====================================================
// ROUTE EXECUTION
// =====================================================
bool executeAction(char action) {
  switch (action) {
    case 'F': return moveForward(DISTANCE_CM);
    case 'B': return moveBackward(DISTANCE_CM);
    case 'R': return turnRight90();
    case 'L': return turnLeft90();
    default:  return false;
  }
}

char inverseAction(char action) {
  switch (action) {
    case 'F': return 'B';
    case 'B': return 'F';
    case 'R': return 'L';
    case 'L': return 'R';
    default: return '?';
  }
}

bool runRoute(const RouteStep* route, uint8_t routeLength, bool returning) {
  if (!returning) {
    for (uint8_t i = 0; i < routeLength; i++) {
      if (stopRequested) return false;
      Serial.printf("Route step %u/%u: %c\n", i + 1, routeLength, route[i].action);
      if (!executeAction(route[i].action)) return false;
      delay(250);
    }
  } else {
    for (int i = (int)routeLength - 1; i >= 0; i--) {
      if (stopRequested) return false;
      char action = inverseAction(route[i].action);
      Serial.printf("Return step %d/%u: %c\n", routeLength - i, routeLength, action);
      if (!executeAction(action)) return false;
      delay(250);
    }
  }
  return true;
}

// =====================================================
// HTTP HELPERS
// =====================================================
String jsonStringField(const String& body, const char* key) {
  String token = String("\"") + key + "\"";
  int keyPos = body.indexOf(token);
  if (keyPos < 0) return "";
  int colon = body.indexOf(':', keyPos + token.length());
  if (colon < 0) return "";
  int firstQuote = body.indexOf('\"', colon + 1);
  if (firstQuote < 0) return "";
  int secondQuote = body.indexOf('\"', firstQuote + 1);
  if (secondQuote < 0) return "";
  return body.substring(firstQuote + 1, secondQuote);
}

// =====================================================
// RFID AUTHENTICATION + SERVO COMPARTMENT CONTROL
// =====================================================
void moveServoSlowly(int targetAngle) {
  targetAngle = constrain(targetAngle, 0, 180);

  if (targetAngle > currentServoAngle) {
    for (int angle = currentServoAngle; angle <= targetAngle; angle++) {
      medicineServo.write(angle);
      delay(SERVO_STEP_DELAY_MS);
    }
  } else {
    for (int angle = currentServoAngle; angle >= targetAngle; angle--) {
      medicineServo.write(angle);
      delay(SERVO_STEP_DELAY_MS);
    }
  }

  currentServoAngle = targetAngle;
}

const char* destinationForCardUID() {
  if (rfid.uid.size != 4) return nullptr;

  if (memcmp(rfid.uid.uidByte, RFID_UID_WARD_A, 4) == 0) return "WARD A";
  if (memcmp(rfid.uid.uidByte, RFID_UID_WARD_B, 4) == 0) return "WARD B";
  if (memcmp(rfid.uid.uidByte, RFID_UID_PHARMACY, 4) == 0) return "PHARMACY";
  if (memcmp(rfid.uid.uidByte, RFID_UID_EMERGENCY, 4) == 0) return "EMERGENCY ROOM";

  return nullptr;
}

void printScannedUID() {
  Serial.print("RFID UID: ");
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) Serial.print("0");
    Serial.print(rfid.uid.uidByte[i], HEX);
    if (i + 1 < rfid.uid.size) Serial.print(" ");
  }
  Serial.println();
}

void handleRFIDScan() {
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  printScannedUID();

  // RFID must only operate after a successful arrival and while navigation is stopped.
  if (!deliveryComplete || navigationRunning || robotState != STATE_IDLE) {
    strncpy(accessStatus, "NOT_AT_DELIVERY_POINT", sizeof(accessStatus) - 1);
    Serial.println("ACCESS DENIED: robot is not waiting at a delivery point.");
  } else if (!lidOpen) {
    const char* cardDestination = destinationForCardUID();

    if (cardDestination == nullptr) {
      strncpy(accessStatus, "UNKNOWN_CARD", sizeof(accessStatus) - 1);
      Serial.println("ACCESS DENIED: unknown RFID card.");
    } else if (String(cardDestination) != String(lastDestination)) {
      strncpy(accessStatus, "WRONG_DESTINATION", sizeof(accessStatus) - 1);
      Serial.printf("ACCESS DENIED: card belongs to %s, robot is at %s.\n",
                    cardDestination, lastDestination);
    } else {
      memcpy(openingCardUID, rfid.uid.uidByte, 4);
      Serial.println("ACCESS GRANTED: destination and card match.");
      moveServoSlowly(LID_OPEN_ANGLE);
      lidOpen = true;
      strncpy(accessStatus, "LID_OPEN", sizeof(accessStatus) - 1);
      Serial.println("Medicine compartment OPEN (90 degrees).");
    }
  } else {
    // Once opened, only the exact same card can close the compartment.
    if (rfid.uid.size == 4 && memcmp(rfid.uid.uidByte, openingCardUID, 4) == 0) {
      Serial.println("SAME CARD CONFIRMED: closing compartment.");
      moveServoSlowly(LID_CLOSED_ANGLE);
      lidOpen = false;
      deliveryComplete = false; // This delivery has now been dispensed; no reopening.
      strncpy(accessStatus, "DELIVERY_DISPENSED", sizeof(accessStatus) - 1);
      Serial.println("Medicine compartment CLOSED. Delivery dispensed.");
    } else {
      strncpy(accessStatus, "SAME_CARD_REQUIRED", sizeof(accessStatus) - 1);
      Serial.println("ACCESS DENIED: scan the same card that opened the compartment.");
    }
  }

  accessStatus[sizeof(accessStatus) - 1] = '\0';
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(800); // brief scan debounce
}

const char* stateName() {
  switch (robotState) {
    case STATE_MOVING:    return "MOVING";
    case STATE_RETURNING: return "RETURNING";
    case STATE_OBSTACLE:  return "OBSTACLE";
    case STATE_STOPPED:   return "STOPPED";
    case STATE_ERROR:     return "ERROR";
    case STATE_IDLE:
    default:              return "IDLE";
  }
}

String makeStatusJson() {
  String ip = WiFi.isConnected() ? WiFi.localIP().toString() : "0.0.0.0";
  String json = "{";
  json += "\"robotState\":\"" + String(stateName()) + "\",";
  json += "\"lastCommand\":\"" + String(lastCommand) + "\",";
  json += "\"lastDestination\":\"" + String(lastDestination) + "\",";
  json += "\"commandCount\":" + String(commandCount) + ",";
  json += "\"uptime\":" + String(millis() / 1000) + ",";
  json += "\"ip\":\"" + ip + "\",";
  json += "\"obstacleDetected\":" + String(obstacleDetected ? "true" : "false") + ",";
  json += "\"deliveryComplete\":" + String(deliveryComplete ? "true" : "false") + ",";
  json += "\"lidOpen\":" + String(lidOpen ? "true" : "false") + ",";
  json += "\"accessStatus\":\"" + String(accessStatus) + "\",";
  if (currentDistanceCm >= 0) {
    json += "\"distanceCm\":" + String(currentDistanceCm, 1);
  } else {
    json += "\"distanceCm\":-1";
  }
  json += "}";
  return json;
}

void sendJson(int code, const String& body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.send(code, "application/json", body);
}

bool copyRouteForDestination(const String& destination) {
  const RouteStep* selected = nullptr;
  uint8_t length = 0;

  if (destination == "WARD A") {
    selected = ROUTE_WARD_A;
    length = sizeof(ROUTE_WARD_A) / sizeof(ROUTE_WARD_A[0]);
  } else if (destination == "WARD B") {
    selected = ROUTE_WARD_B;
    length = sizeof(ROUTE_WARD_B) / sizeof(ROUTE_WARD_B[0]);
  } else if (destination == "PHARMACY") {
    selected = ROUTE_PHARMACY;
    length = sizeof(ROUTE_PHARMACY) / sizeof(ROUTE_PHARMACY[0]);
  } else if (destination == "EMERGENCY ROOM") {
    selected = ROUTE_EMERGENCY;
    length = sizeof(ROUTE_EMERGENCY) / sizeof(ROUTE_EMERGENCY[0]);
  } else {
    return false;
  }

  if (length > (sizeof(savedRoute) / sizeof(savedRoute[0]))) return false;
  for (uint8_t i = 0; i < length; i++) savedRoute[i] = selected[i];
  savedRouteLength = length;
  hasSavedRoute = true;
  return true;
}

void navigationTask(void* parameter) {
  bool returning = ((intptr_t)parameter == 1);
  bool success = false;

  if (returning) {
    success = runRoute(savedRoute, savedRouteLength, true);
  } else {
    success = runRoute(savedRoute, savedRouteLength, false);
  }

  stopMotors();
  obstacleDetected = false;

  if (stopRequested) {
    atBase = false; // Position is unknown after interruption
    deliveryComplete = false;
    robotState = STATE_STOPPED;
    strncpy(lastCommand, "STOP", sizeof(lastCommand) - 1);
    strncpy(accessStatus, "NOT_AT_DELIVERY_POINT", sizeof(accessStatus) - 1);
  } else if (!success) {
    atBase = false;
    deliveryComplete = false;
    robotState = STATE_ERROR;
    strncpy(lastCommand, "ERROR", sizeof(lastCommand) - 1);
    strncpy(accessStatus, "NAVIGATION_ERROR", sizeof(accessStatus) - 1);
  } else if (returning) {
    robotState = STATE_IDLE;
    atBase = true;
    deliveryComplete = false;
    strncpy(lastCommand, "RETURNED", sizeof(lastCommand) - 1);
    strncpy(lastDestination, "RECEPTION", sizeof(lastDestination) - 1);
    strncpy(accessStatus, "WAITING_FOR_DELIVERY", sizeof(accessStatus) - 1);
  } else {
    robotState = STATE_IDLE;
    atBase = false;
    deliveryComplete = true; // Successful route completion enables RFID access.
    strncpy(lastCommand, "ARRIVED", sizeof(lastCommand) - 1);
    strncpy(accessStatus, "AWAITING_RFID", sizeof(accessStatus) - 1);
  }

  lastCommand[sizeof(lastCommand) - 1] = '\0';
  lastDestination[sizeof(lastDestination) - 1] = '\0';
  navigationRunning = false;
  vTaskDelete(nullptr);
}

// =====================================================
// HTTP ENDPOINTS
// =====================================================
void handleStatus() {
  // If idle and not actively navigating, take a quick ambient distance reading
  if (!navigationRunning) {
    float ambientDist = readUltrasonicDistanceCm();
    if (ambientDist > 0) currentDistanceCm = ambientDist;
  }
  sendJson(200, makeStatusJson());
}

void handleCommand() {
  String body = server.arg("plain");
  String command = jsonStringField(body, "command");
  String destination = jsonStringField(body, "destination");
  command.trim();
  destination.trim();
  command.toUpperCase();
  destination.toUpperCase();

  Serial.printf("HTTP command=%s destination=%s\n", command.c_str(), destination.c_str());

  if (command == "STOP") {
    if (navigationRunning) {
      stopRequested = true;
      stopMotors();
      obstacleDetected = false;
      robotState = STATE_STOPPED;
      strncpy(lastCommand, "STOP", sizeof(lastCommand) - 1);
      sendJson(200, "{\"success\":true,\"message\":\"Stop requested\"}");
    } else {
      stopMotors();
      sendJson(200, "{\"success\":true,\"message\":\"Robot is already stationary\"}");
    }
    return;
  }

  if (command == "STATUS") {
    sendJson(200, makeStatusJson());
    return;
  }

  if (command != "MOVE") {
    sendJson(400, "{\"success\":false,\"message\":\"Unsupported command\"}");
    return;
  }

  if (navigationRunning) {
    sendJson(409, "{\"success\":false,\"message\":\"Robot is already executing a route\"}");
    return;
  }

  bool returning = (destination == "RECEPTION" || destination == "BASE");

  if (returning) {
    if (lidOpen) {
      sendJson(409, "{\"success\":false,\"message\":\"Close the medicine compartment with the same RFID card before returning\"}");
      return;
    }
    if (atBase || !hasSavedRoute || (robotState != STATE_IDLE && robotState != STATE_STOPPED)) {
      sendJson(409, "{\"success\":false,\"message\":\"Return is available only after a completed destination route\"}");
      return;
    }
  } else {
    if (lidOpen) {
      sendJson(409, "{\"success\":false,\"message\":\"Medicine compartment is open; close it before starting another route\"}");
      return;
    }
    if (!atBase) {
      sendJson(409, "{\"success\":false,\"message\":\"Robot is away from reception. Return to base before selecting another destination\"}");
      return;
    }
    if (!copyRouteForDestination(destination)) {
      sendJson(400, "{\"success\":false,\"message\":\"Unknown destination\"}");
      return;
    }
  }

  stopRequested = false;
  if (!returning) {
    deliveryComplete = false;
    strncpy(accessStatus, "NAVIGATING", sizeof(accessStatus) - 1);
  }
  navigationRunning = true;
  commandCount++;
  strncpy(lastCommand, returning ? "RETURN" : "MOVE", sizeof(lastCommand) - 1);
  strncpy(lastDestination, returning ? "RECEPTION" : destination.c_str(), sizeof(lastDestination) - 1);
  lastCommand[sizeof(lastCommand) - 1] = '\0';
  lastDestination[sizeof(lastDestination) - 1] = '\0';
  robotState = returning ? STATE_RETURNING : STATE_MOVING;

  BaseType_t taskCreated = xTaskCreate(
    navigationTask,
    "CuraBotNavigation",
    8192,
    (void*)(intptr_t)(returning ? 1 : 0),
    1,
    nullptr
  );

  if (taskCreated != pdPASS) {
    navigationRunning = false;
    robotState = STATE_ERROR;
    sendJson(500, "{\"success\":false,\"message\":\"Could not start navigation task\"}");
    return;
  }

  sendJson(200, returning
    ? "{\"success\":true,\"message\":\"Return-to-base route started\"}"
    : "{\"success\":true,\"message\":\"Destination route started\"}");
}

void handleOptions() {
  sendJson(204, "{}");
}

// =====================================================
// SETUP / LOOP
// =====================================================
void setup() {
  Serial.begin(115200);

  // Motor pins
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  // Encoder pins
  pinMode(LEFT_A, INPUT);
  pinMode(LEFT_B, INPUT);
  pinMode(RIGHT_A, INPUT);
  pinMode(RIGHT_B, INPUT);

  // Ultrasonic sensor pins
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  prevLeft = (digitalRead(LEFT_A) << 1) | digitalRead(LEFT_B);
  prevRight = (digitalRead(RIGHT_A) << 1) | digitalRead(RIGHT_B);

  attachInterrupt(digitalPinToInterrupt(LEFT_A), leftEncoderISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(LEFT_B), leftEncoderISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(RIGHT_A), rightEncoderISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(RIGHT_B), rightEncoderISR, CHANGE);

  stopMotors();

  // Initialise the medicine compartment servo
  medicineServo.setPeriodHertz(50);
  medicineServo.attach(SERVO_PIN, 500, 2400);
  medicineServo.write(LID_CLOSED_ANGLE);
  currentServoAngle = LID_CLOSED_ANGLE;

  // Initialise RC522 RFID reader
  SPI.begin(RFID_SCK_PIN, RFID_MISO_PIN, RFID_MOSI_PIN, RFID_SS_PIN);
  rfid.PCD_Init();
  byte rfidVersion = rfid.PCD_ReadRegister(rfid.VersionReg);
  Serial.printf("RC522 firmware version: 0x%02X\n", rfidVersion);
  if (rfidVersion == 0x00 || rfidVersion == 0xFF) {
    Serial.println("WARNING: RC522 not responding; check RFID wiring/power.");
  } else {
    Serial.println("RC522 RFID reader initialised.");
  }

  Serial.println("\nCuraBot+ booting with obstacle guard + RFID compartment access...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi not connected. Will keep trying in loop().");
  }

  server.on("/status", HTTP_GET, handleStatus);
  server.on("/command", HTTP_POST, handleCommand);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  server.on("/command", HTTP_OPTIONS, handleOptions);
  server.onNotFound([]() {
    sendJson(404, "{\"success\":false,\"message\":\"Endpoint not found\"}");
  });
  server.begin();

  Serial.println("HTTP server ready on port 80.");
  Serial.println("Obstacle Guard Active (TRIG=4, ECHO=35).");
  Serial.println("RFID access: scan destination card once to OPEN, scan same card again to CLOSE.");
  Serial.println("Waiting for dashboard commands.");
}

void loop() {
  server.handleClient();
  handleRFIDScan();

  static unsigned long lastReconnectAttempt = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastReconnectAttempt > 10000) {
    lastReconnectAttempt = millis();
    WiFi.reconnect();
  }

  delay(2);
}
