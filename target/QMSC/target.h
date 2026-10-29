/*
 * quadmath-sim-core target: Betaflight compiled to WebAssembly, flying a
 * simulated quad. Included by Betaflight's platform.h after
 * target/common_pre.h and before target/common_post.h.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#pragma once

#include <stdint.h>
#include <stddef.h>
#include "common/utils.h"

#define TARGET_BOARD_IDENTIFIER "QMSC"
#define SYSTEM_HSE_MHZ 0
#define DEFAULT_CPU_OVERCLOCK 0
#define U_ID_0 0
#define U_ID_1 1
#define U_ID_2 2

// One virtual gyro and one virtual acc, fed by the plant every tick.
#define USE_ACC
#define USE_VIRTUAL_ACC
#define USE_GYRO
#define USE_VIRTUAL_GYRO

// DShot digital idle, bidirectional telemetry for the RPM filter and dynamic
// idle. USE_DYN_NOTCH_FILTER survives SIMULATOR_BUILD through patch 0001.
#define USE_DSHOT
#define USE_DSHOT_TELEMETRY
#define USE_DSHOT_TELEMETRY_STATS
#define USE_RPM_FILTER
#define USE_DYN_IDLE
#define USE_DYN_NOTCH_FILTER

// Betaflight's beeper (io/beeper.c), its state a readout for the page to
// play (FC_BEEPER): no buzzer pin (BEEPER_PIN NONE; src/glue/hal_beeper.c).
// The DShot beacon stays off, Betaflight's default: the policy refuses
// 'beacon' (cli-policy.js).
#define USE_BEEPER

// Battery measured by Betaflight through the ADC. Without these the meter
// sources default to NONE (sensors/battery.c) and Betaflight never reads it.
#define USE_ADC
#define DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC
#define DEFAULT_CURRENT_METER_SOURCE CURRENT_METER_ADC

// The config image lives in a RAM array; sim-core carries it across reinits.
#define CONFIG_IN_RAM
#define EEPROM_SIZE      32768
#define FLASH_PAGE_SIZE  0x400

#define USABLE_TIMER_CHANNEL_COUNT 0
#define DEFIO_NO_PORTS

// One serial port object, used only as the CLI port by the config instance.
#define USE_UART1
#define SERIAL_PORT_COUNT 1

// Sticks enter through Betaflight's MSP receiver.
#define DEFAULT_RX_FEATURE FEATURE_RX_MSP
#define DEFAULT_FEATURES   0

#define DMA_RAM
#define DMA_RW_AXI
#define DMA_RAM_R
#define DMA_RAM_W
#define DMA_RAM_RW
#define DMA_DATA_ZERO_INIT
#define DMA_DATA
#define STATIC_DMA_DATA_AUTO

// Hardware, telemetry and UI paths sim-core does not have.
#undef USE_DSHOT_BITBANG
#undef USE_DSHOT_DMAR
#undef USE_ESC_SENSOR
#undef USE_ESC_SENSOR_INFO
#undef USE_ESC_SENSOR_TELEMETRY
#undef USE_GYRO_REGISTER_DUMP
#undef USE_SERIAL_PASSTHROUGH
#undef USE_SERIAL_4WAY_BLHELI_BOOTLOADER
#undef USE_RCDEVICE
#undef USE_MSP_OVER_TELEMETRY
#undef USE_VIRTUAL_CURRENT_METER
#undef USE_RX_MSP_OVERRIDE
#undef USE_PERSISTENT_STATS
#undef USE_RTC_TIME
#undef USE_HOTT_TEXTMODE
#undef USE_CRAFTNAME_MSGS
#undef USE_TELEMETRY_SENSORS_DISABLED_DETAILS
#undef USE_RESOURCE_MGMT
#undef USE_BOARD_INFO
#undef USE_SIGNATURE
#undef USE_SENSOR_NAMES
#undef USE_UNCOMMON_MIXERS
#undef USE_HUFFMAN
#undef USE_STACK_CHECK
#undef USE_VCP
#undef USE_I2C
#undef USE_SPI
