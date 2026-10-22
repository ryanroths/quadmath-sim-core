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

// Fault codes (sc_fault). Betaflight failureMode(mode) maps to 100 + mode.
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

extern int sc_fault;
extern bool sc_reboot_requested;

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
    double erpm[SC_MOTOR_COUNT];// electrical rpm per motor
    double vbat_v;              // loaded pack voltage at the board
    double current_a;           // pack current
} sc_sensors_t;

extern sc_sensors_t sc_sensors;

// Plant interface (src/plant).
void sc_plant_init(void);
void sc_plant_step(double dt_s);

// Tick (src/glue/tick.c).
void sc_tick_init(void);
int sc_tick_run(int ticks);
void sc_rx_set_rate(int hz);
int sc_input_push(uint64_t t_us, const uint16_t *ch, int n);
void sc_rx_link(bool up);

// Sensors (src/glue/hal_sensors.c) and CLI (src/glue/cli_port.c).
void sc_sensors_to_betaflight(void);
void sc_cli_enter(void);
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
