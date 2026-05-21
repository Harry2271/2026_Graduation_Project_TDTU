// motor_control.ino
// ESP32-S3 (WeAct ESP32-S3-A N16R8)
// Communication: Serial USB (115200 baud) with Raspberry Pi 5
// Hardware: 4x DC motors + L298N dual H-bridge drivers, Mecanum wheels
//           2x servo for robotic arm (gripper + shoulder)

#include <Arduino.h>

// ---------------------------------------------------------------------------
// Motor Driver Pin Assignments (L298N)
// ---------------------------------------------------------------------------
// Motor 1: Front-Left  (FL)
#define FL_EN   13   // PWM speed
#define FL_IN1  14
#define FL_IN2  21

// Motor 2: Front-Right (FR)
#define FR_EN   12   // PWM speed
#define FR_IN1  10
#define FR_IN2  11

// Motor 3: Back-Left   (BL)
#define BL_EN    9   // PWM speed
#define BL_IN1   7
#define BL_IN2   6

// Motor 4: Back-Right  (BR)
#define BR_EN    8   // PWM speed
#define BR_IN1   4
#define BR_IN2   5

// Robotic Arm Servo Pins
#define ARM_SHOULDER_PIN  15  // Servo for shoulder/elevation
#define ARM_GRIPPER_PIN   16  // Servo for gripper/open-close

// ---------------------------------------------------------------------------
// Mecanum Wheel Kinematics Constants
// ---------------------------------------------------------------------------
#define WHEEL_RADIUS      0.06   // meters  (6 cm wheel)
#define WHEEL_BASE_X      0.18   // half-track width  (18 cm)
#define WHEEL_BASE_Y      0.15   // half-wheelbase    (15 cm)
#define MAX_PWM           255
#define PWM_DEADZONE      30

// ---------------------------------------------------------------------------
// Serial Protocol Constants
// ---------------------------------------------------------------------------
#define SERIAL_BAUD       115200
#define CMD_DELIMITER     '\n'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
enum RobotState {
  STATE_IDLE = 0,
  STATE_MOVING = 1,
  STATE_OBSTACLE = 2,
  STATE_PICKUP = 3,
  STATE_DEPOSIT = 4,
  STATE_DONE = 5
};

volatile RobotState robotState = STATE_IDLE;
volatile int armShoulderAngle = 90;   // degrees (0-180)
volatile int armGripperAngle = 60;    // degrees (0-180, 60=open, 10=closed)

// Motor speed targets (-255 to 255)
int fl_speed = 0, fr_speed = 0, bl_speed = 0, br_speed = 0;

// PID speed control
struct MotorPID {
  float target = 0;
  float current = 0;
  float integral = 0;
  float last_error = 0;
  unsigned long last_time = 0;
};

MotorPID pidFL, pidFR, pidBL, pidBR;
const float Kp = 0.4f, Ki = 0.05f, Kd = 0.1f;

// Encoder pulse count (simulated, no real encoder attached)
volatile long encFL = 0, encFR = 0, encBL = 0, encBR = 0;

// ---------------------------------------------------------------------------
// Proto parsing
// ---------------------------------------------------------------------------
// Command format from Pi 5:
//   MOVE,<vx>,<vy>,<omega>          — mecanum drive (float)
//   STOP                           — brake all motors
//   ARM,<shoulder>,<gripper>       — set arm angles (int 0-180)
//   STATE,<state>                  — set robot state (0-5)
//   STATUS                         — request sensor/status report
//   HOME                           — reset arm to home position
//   PICKUP                         — macro: lower arm, close gripper
//   DEPOSIT                        — macro: raise arm, open gripper

void parseCommand(const String& cmd) {
  if (cmd.length() == 0) return;

  int comma1 = cmd.indexOf(',');
  String type = (comma1 == -1) ? cmd : cmd.substring(0, comma1);

  if (type == "MOVE") {
    // MOVE,<vx>,<vy>,<omega>
    int c2 = cmd.indexOf(',', comma1 + 1);
    int c3 = cmd.indexOf(',', c2 + 1);
    if (c2 == -1 || c3 == -1) return;

    float vx   = cmd.substring(comma1 + 1, c2).toFloat();
    float vy   = cmd.substring(c2 + 1, c3).toFloat();
    float omega = cmd.substring(c3 + 1).toFloat();

    mecanumDrive(vx, vy, omega);
    robotState = STATE_MOVING;

  } else if (type == "STOP") {
    stopMotors();
    robotState = STATE_IDLE;

  } else if (type == "ARM") {
    // ARM,<shoulder>,<gripper>
    int c2 = cmd.indexOf(',', comma1 + 1);
    if (c2 == -1) return;
    int shoulder = cmd.substring(comma1 + 1, c2).toInt();
    int gripper  = cmd.substring(c2 + 1).toInt();
    setArmAngles(shoulder, gripper);

  } else if (type == "STATE") {
    int s = cmd.substring(comma1 + 1).toInt();
    robotState = (RobotState)constrain(s, 0, 5);

  } else if (type == "HOME") {
    setArmAngles(90, 60);

  } else if (type == "PICKUP") {
    // Lower arm to pickup position, close gripper
    setArmAngles(30, 60); // lower, open
    delay(1500);
    setArmAngles(30, 10); // close gripper
    robotState = STATE_PICKUP;

  } else if (type == "DEPOSIT") {
    // Raise arm, open gripper
    setArmAngles(160, 10); // hold high
    delay(1000);
    setArmAngles(160, 60); // release
    robotState = STATE_DEPOSIT;

  } else if (type == "STATUS") {
    sendStatus();
  }
}

// ---------------------------------------------------------------------------
// Mecanum Kinematics
// ---------------------------------------------------------------------------
// vx  = forward (+) / backward (-)
// vy  = right strafe (+) / left strafe (-)
// omega = counter-clockwise (+) / clockwise (-)
void mecanumDrive(float vx, float vy, float omega) {
  // Motor equations for 4-wheel mecanum (roller angle 45 deg)
  float fl =  vx - vy - omega;
  float fr =  vx + vy + omega;
  float bl =  vx + vy - omega;
  float br =  vx - vy + omega;

  // Normalize to max |value| = 1
  float maxVal = max({abs(fl), abs(fr), abs(bl), abs(br), 1.0f});
  fl /= maxVal;
  fr /= maxVal;
  bl /= maxVal;
  br /= maxVal;

  // Scale to PWM range
  fl_speed = (int)(fl * MAX_PWM);
  fr_speed = (int)(fr * MAX_PWM);
  bl_speed = (int)(bl * MAX_PWM);
  br_speed = (int)(br * MAX_PWM);
}

void stopMotors() {
  fl_speed = fr_speed = bl_speed = br_speed = 0;
  setMotorPWM(FL_EN, FL_IN1, FL_IN2, 0);
  setMotorPWM(FR_EN, FR_IN1, FR_IN2, 0);
  setMotorPWM(BL_EN, BL_IN1, BL_IN2, 0);
  setMotorPWM(BR_EN, BR_IN1, BR_IN2, 0);
}

// ---------------------------------------------------------------------------
// Motor Driver Helpers
// ---------------------------------------------------------------------------
void setMotorPWM(int enPin, int in1, int in2, int speed) {
  speed = constrain(speed, -MAX_PWM, MAX_PWM);

  if (abs(speed) < PWM_DEADZONE) {
    digitalWrite(in1, LOW);
    digitalWrite(in2, LOW);
    analogWrite(enPin, 0);
    return;
  }

  if (speed > 0) {
    digitalWrite(in1, HIGH);
    digitalWrite(in2, LOW);
  } else {
    digitalWrite(in1, LOW);
    digitalWrite(in2, HIGH);
  }
  analogWrite(enPin, abs(speed));
}

void driveMotors() {
  setMotorPWM(FL_EN, FL_IN1, FL_IN2, fl_speed);
  setMotorPWM(FR_EN, FR_IN1, FR_IN2, fr_speed);
  setMotorPWM(BL_EN, BL_IN1, BL_IN2, bl_speed);
  setMotorPWM(BR_EN, BR_IN1, BR_IN2, br_speed);
}

// ---------------------------------------------------------------------------
// Servo / Arm Control (using Arduino servo library via ledc)
// ---------------------------------------------------------------------------
#include <ESP32Servo.h>
Servo shoulderServo;
Servo gripperServo;

void setArmAngles(int shoulder, int gripper) {
  armShoulderAngle = constrain(shoulder, 0, 180);
  armGripperAngle  = constrain(gripper,  0, 180);
  shoulderServo.write(armShoulderAngle);
  gripperServo.write(armGripperAngle);
}

// ---------------------------------------------------------------------------
// Status Reporting
// ---------------------------------------------------------------------------
void sendStatus() {
  // Format: STAT,state,fl_speed,fr_speed,bl_speed,br_speed,arm_shoulder,arm_gripper,encFL,encFR,encBL,encBR
  String out = "STAT,";
  out += String(robotState) + ",";
  out += String(fl_speed) + ",";
  out += String(fr_speed) + ",";
  out += String(bl_speed) + ",";
  out += String(br_speed) + ",";
  out += String(armShoulderAngle) + ",";
  out += String(armGripperAngle) + ",";
  out += String(encFL) + ",";
  out += String(encFR) + ",";
  out += String(encBL) + ",";
  out += String(encBR);
  Serial.println(out);
}

// ---------------------------------------------------------------------------
// Command Buffer
// ---------------------------------------------------------------------------
#define CMD_BUFFER_SIZE 128
char cmdBuffer[CMD_BUFFER_SIZE];
int cmdLen = 0;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(SERIAL_BAUD);
  while (!Serial && millis() < 3000);  // Wait up to 3s for USB CDC

  // Motor pins
  pinMode(FL_EN, OUTPUT); pinMode(FL_IN1, OUTPUT); pinMode(FL_IN2, OUTPUT);
  pinMode(FR_EN, OUTPUT); pinMode(FR_IN1, OUTPUT); pinMode(FR_IN2, OUTPUT);
  pinMode(BL_EN, OUTPUT); pinMode(BL_IN1, OUTPUT); pinMode(BL_IN2, OUTPUT);
  pinMode(BR_EN, OUTPUT); pinMode(BR_IN1, OUTPUT); pinMode(BR_IN2, OUTPUT);

  // Servo pins
  shoulderServo.attach(ARM_SHOULDER_PIN);
  gripperServo.attach(ARM_GRIPPER_PIN);
  setArmAngles(90, 60);  // home position

  // Brake all motors
  stopMotors();

  // Initialise PID timestamps
  pidFL.last_time = pidFR.last_time = pidBL.last_time = pidBR.last_time = millis();

  Serial.println("ESP32-S3 Motor Controller Ready");
  Serial.println("Commands: MOVE,<vx>,<vy>,<omega> | STOP | ARM,<sh>,<gr> | STATUS | HOME | PICKUP | DEPOSIT");
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------
void loop() {
  // Read serial commands from Pi 5
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == CMD_DELIMITER || c == '\r') {
      if (cmdLen > 0) {
        cmdBuffer[cmdLen] = '\0';
        parseCommand(String(cmdBuffer));
        cmdLen = 0;
      }
    } else {
      if (cmdLen < CMD_BUFFER_SIZE - 1) {
        cmdBuffer[cmdLen++] = c;
      }
    }
  }

  // Apply motor speeds
  driveMotors();

  // Simulate encoder ticks (replace with real encoder ISR if attached)
  if (abs(fl_speed) > PWM_DEADZONE) encFL += fl_speed > 0 ? 1 : -1;
  if (abs(fr_speed) > PWM_DEADZONE) encFR += fr_speed > 0 ? 1 : -1;
  if (abs(bl_speed) > PWM_DEADZONE) encBL += bl_speed > 0 ? 1 : -1;
  if (abs(br_speed) > PWM_DEADZONE) encBR += br_speed > 0 ? 1 : -1;

  // Heartbeat: auto-report status every 500ms when moving
  static unsigned long lastReport = 0;
  if (millis() - lastReport > 500 && robotState == STATE_MOVING) {
    sendStatus();
    lastReport = millis();
  }
}
