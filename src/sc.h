/*
 * quadmath-sim-core internal interface between the glue (src/glue), the plant
 * (src/plant) and the exported ABI (src/glue/abi.c). Not seen by Betaflight.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define SC_ABI_VERSION 1

#define SC_TICK_US (1000000u / SC_LOOP_HZ)
#define SC_MOTOR_COUNT 4
#define SC_RC_CHANNELS 16

// Status codes returned through the ABI.
#define SC_OK 0
#define SC_ERR_BAD_ARG (-1)
#define SC_ERR_BAD_STATE (-2)
#define SC_ERR_FULL (-3)

// Fault codes (sc_fault_state). Betaflight failureMode(mode) maps to 100 + mode.
#define SC_FAULT_NONE 0
#define SC_FAULT_PLANT_DIVERGED 1
#define SC_FAULT_BOOT_TIMEOUT 2
#define SC_FAULT_BF_FAILURE_BASE 100
// Boot asserts (sc_boot_asserts): 200 + the number of the failed check.
#define SC_FAULT_BOOT_ASSERT_BASE 200

// The sim clock starts here, not at 0: Betaflight treats a motor enable time
// of 0 ms as "never enabled" (drivers/dshot_command.c), and a real board has
// been running for a while when init() enables the motors.
#define SC_BOOT_EPOCH_US 1000000u

// Sim clock: 64-bit microseconds since boot. Betaflight sees micros() as its
// low 32 bits and millis() as its own 32-bit millisecond count.
extern uint64_t sc_time_us;

extern int sc_fault_state;
extern bool sc_reboot_flag;
// Set by a tick that fired a trigger: sc_tick_run returns after that tick, so
// the host acts on it (a portal's pose) at the same tick boundary whatever its
// frame time (PROGRESS.md frame-time leak (i)).
extern bool sc_tick_stop;

// Raises a fault (first one wins) and queues its event. The tick stops.
void sc_set_fault(int code);

// Event queue (src/glue/abi.c), drained by sim-core.js. One event is
// SC_EVENT_DOUBLES doubles: t_us, kind, then up to 6 kind-specific values.
#define SC_EVENT_DOUBLES 8
#define SC_EVENT_CONTACT 1          // values: box id (-1 floor), impact m/s, crashed
#define SC_EVENT_FLOOR_TOUCH 2      // values: -1
#define SC_EVENT_FLOOR_LEAVE 3      // values: -1
#define SC_EVENT_TRIGGER 4          // values: trigger id
#define SC_EVENT_FAULT 9            // values: fault code
void sc_event_push(int kind, const double *values, int n);

// Trace hash: SHA-256 over the state and Betaflight blocks after every tick.
void sc_trace_tick(void);

typedef struct {
    uint32_t h[8];
    uint64_t bytes;
    uint8_t block[64];
    uint32_t fill;
} sc_sha256_t;

void sc_sha256_init(sc_sha256_t *s);
void sc_sha256_update(sc_sha256_t *s, const void *data, uint32_t len);
void sc_sha256_final(const sc_sha256_t *s, uint8_t digest[32]);

// Log shared by the CLI port and the glue: CLI output, warnings, notes.
void sc_log_append(const char *text, int len);
void sc_log_appendf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

// Motor outputs captured from Betaflight's motor device (DShot values:
// 0 = stop, 48..2047 = throttle), and spin direction from DShot commands.
extern float sc_motor_value[SC_MOTOR_COUNT];
extern int8_t sc_motor_dir[SC_MOTOR_COUNT];
extern bool sc_motors_enabled;

// What the plant reports to the sensor stubs, refreshed after every plant step.
typedef struct {
    double gyro_dps[3];         // body rates, deg/s, Betaflight axis order (roll, pitch, yaw)
    double acc_g[3];            // specific force, g, Betaflight body axes
    double rpm[SC_MOTOR_COUNT]; // mechanical rpm per motor (hal_motor.c makes it eRPM)
    double vbat_v;              // loaded pack voltage at the board
    double current_a;           // pack current
} sc_sensors_t;

extern sc_sensors_t sc_sensors;

// What the plant publishes through state block v1: SI units, quadmath's
// module frame (X forward, Y left, Z up).
typedef struct {
    double pos[3];                  // m, world
    double vel[3];                  // m/s, world
    double quat[4];                 // w x y z, body to world
    double omega[3];                // rad/s, body
    double specificForce[3];        // m/s^2, body (what an accelerometer reads)
    double motorOut[SC_MOTOR_COUNT];// spooled output, signed, -1..1
    double rpm[SC_MOTOR_COUNT];
    double thrustN[SC_MOTOR_COUNT];
    double vbatLoaded;              // V, at the board under load
    double vbatFiltered;            // V, what a reinit carries (not in the state block)
    double amps;
    double mah;
    double soc;                     // 1 full, 0 at the capacity, down to SC_SOC_FLOOR (physical)
    double groundClearance;         // m
    bool airborne;
    uint32_t contactFlags;
} sc_plant_state_t;

extern sc_plant_state_t sc_plant;

// Plant interface (src/plant).
void sc_plant_init(void);
void sc_plant_step(double dt_s);
// Battery carried across a reinit: state of charge and filtered voltage.
void sc_plant_battery_carry(double soc, double vbat_filtered);

// Tick (src/glue/tick.c).
void sc_tick_init(void);
int sc_tick_run(int ticks);
void sc_rx_set_rate(int hz);
int sc_input_push(uint64_t t_us, const uint16_t *ch, int n);
void sc_rx_link_set(bool up);
bool sc_neutral_frame_valid(void);

// Sensors (src/glue/hal_sensors.c) and CLI (src/glue/cli_port.c).
void sc_sensors_to_betaflight(void);
void sc_cli_port_enter(void);
bool sc_cli_active(void);
int sc_cli_feed(const char *line, int len);
const char *sc_log_ptr(void);
int sc_log_len(void);
bool sc_log_truncated(void);
void sc_log_clear(void);

// Boot (src/glue/boot.c).
void sc_boot_betaflight(void);
int sc_boot_asserts(void);
int sc_pg_missing_count(void);
