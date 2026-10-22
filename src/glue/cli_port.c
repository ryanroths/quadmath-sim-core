/*
 * The CLI port: a serial port whose receive side is the line being applied and
 * whose transmit side is the sim-core log. Used only by the config instance;
 * the instance that flies never enters CLI mode (cliEnter disables arming
 * until a reboot).
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "platform.h"

#include "cli/cli.h"
#include "drivers/serial.h"

#include "sc.h"

// The log holds CLI output, warnings and notes until JS reads and clears it.
#define SC_LOG_SIZE (256 * 1024)
static char scLog[SC_LOG_SIZE];
static int scLogLen;
static bool scLogTruncated;

void sc_log_append(const char *text, int len)
{
    if (len <= 0) {
        return;
    }
    const int room = SC_LOG_SIZE - scLogLen;
    if (len > room) {
        len = room;
        scLogTruncated = true;
    }
    memcpy(&scLog[scLogLen], text, (size_t)len);
    scLogLen += len;
}

void sc_log_appendf(const char *fmt, ...)
{
    char line[256];
    va_list ap;
    va_start(ap, fmt);
    const int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    sc_log_append(line, n < (int)sizeof(line) ? n : (int)sizeof(line) - 1);
}

const char *sc_log_ptr(void)
{
    return scLog;
}

int sc_log_len(void)
{
    return scLogLen;
}

bool sc_log_truncated(void)
{
    return scLogTruncated;
}

void sc_log_clear(void)
{
    scLogLen = 0;
    scLogTruncated = false;
}

#define CLI_RX_SIZE 512
static uint8_t cliRx[CLI_RX_SIZE];
static uint32_t cliRxHead;
static uint32_t cliRxTail;
static serialPort_t scCliPort;
static bool scCliActive;

static void cliPortWrite(serialPort_t *instance, uint8_t ch)
{
    UNUSED(instance);
    const char c = (char)ch;
    sc_log_append(&c, 1);
}

static uint32_t cliPortRxWaiting(const serialPort_t *instance)
{
    UNUSED(instance);
    return cliRxHead - cliRxTail;
}

static uint32_t cliPortTxFree(const serialPort_t *instance)
{
    UNUSED(instance);
    return CLI_RX_SIZE;
}

static uint8_t cliPortRead(serialPort_t *instance)
{
    UNUSED(instance);
    return cliRx[cliRxTail++ % CLI_RX_SIZE];
}

static void cliPortSetBaudRate(serialPort_t *instance, uint32_t baudRate)
{
    UNUSED(instance);
    UNUSED(baudRate);
}

// Must be true, or a reboot waits forever (io/serial.c).
static bool cliPortTxEmpty(const serialPort_t *instance)
{
    UNUSED(instance);
    return true;
}

static void cliPortSetMode(serialPort_t *instance, portMode_e mode)
{
    UNUSED(instance);
    UNUSED(mode);
}

static void cliPortWriteBuf(serialPort_t *instance, const void *data, int count)
{
    UNUSED(instance);
    sc_log_append((const char *)data, count);
}

static const struct serialPortVTable cliPortVTable = {
    .serialWrite = cliPortWrite,
    .serialTotalRxWaiting = cliPortRxWaiting,
    .serialTotalTxFree = cliPortTxFree,
    .serialRead = cliPortRead,
    .serialSetBaudRate = cliPortSetBaudRate,
    .isSerialTransmitBufferEmpty = cliPortTxEmpty,
    .setMode = cliPortSetMode,
    .setCtrlLineStateCb = NULL,
    .setBaudRateCb = NULL,
    .writeBuf = cliPortWriteBuf,
    .beginWrite = NULL,
    .endWrite = NULL,
};

void sc_cli_enter(void)
{
    memset(&scCliPort, 0, sizeof(scCliPort));
    scCliPort.vTable = &cliPortVTable;
    scCliPort.mode = MODE_RXTX;
    scCliPort.baudRate = 115200;
    cliRxHead = cliRxTail = 0;
    cliEnter(&scCliPort);
    scCliActive = true;
}

bool sc_cli_active(void)
{
    return scCliActive;
}

// Feeds one line and runs Betaflight's CLI on it. After a reboot request the
// line is dropped, as the firmware would drop input after resetting.
int sc_cli_feed(const char *line, int len)
{
    // Betaflight's line buffer is 256 bytes and its terminator is written at
    // cliBuffer[bufferIndex] (cli/cli.c), so 255 is the longest safe line.
    if (!scCliActive || len < 0 || len > 255) {
        return SC_ERR_BAD_ARG;
    }
    if (sc_reboot_requested) {
        return SC_ERR_BAD_STATE;
    }
    for (int i = 0; i < len; i++) {
        cliRx[cliRxHead++ % CLI_RX_SIZE] = (uint8_t)line[i];
    }
    cliRx[cliRxHead++ % CLI_RX_SIZE] = '\n';
    while (cliRxHead != cliRxTail && !sc_reboot_requested) {
        cliProcess();
    }
    cliRxTail = cliRxHead;
    return SC_OK;
}
