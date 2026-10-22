/*
 * quadmath-sim-core MCU layer. Single-threaded WebAssembly: no interrupts, so
 * BASEPRI is a no-op. Opaque types stand in for the MCU structs Betaflight's
 * headers name unconditionally (io.h, timer.h, dma.h, adc.h, dshot_dpwm.h).
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#pragma once

#include <stdint.h>

#define __ASM __asm
static inline uint32_t __get_BASEPRI(void) { return 0; }
static inline void __set_BASEPRI(uint32_t v) { (void)v; }
static inline void __set_BASEPRI_MAX(uint32_t v) { (void)v; }
#define NVIC_PriorityGroup_2 0x500

// Betaflight's MCU headers define these (drivers/stm32/platform_mcu.h); scheduler.c
// and fc/tasks.c need them. The loop rate is the SC_LOOP_HZ build parameter.
#ifndef SC_LOOP_HZ
#error "SC_LOOP_HZ must be set by scripts/build.sh"
#endif
#define SCHEDULER_DELAY_LIMIT 100
#define TASK_GYROPID_DESIRED_PERIOD (1000000 / SC_LOOP_HZ)

extern uint32_t SystemCoreClock;

typedef enum { Mode_TEST = 0x0, Mode_Out_PP = 0x10 } GPIO_Mode;
typedef enum { RESET = 0, SET = !RESET } FlagStatus, ITStatus;
typedef enum { DISABLE = 0, ENABLE = !DISABLE } FunctionalState;
typedef enum { TEST_IRQ = 0 } IRQn_Type;
typedef enum { EXTI_Trigger_Rising = 0x08, EXTI_Trigger_Falling = 0x0C, EXTI_Trigger_Rising_Falling = 0x10 } EXTITrigger_TypeDef;
typedef struct { uint32_t IDR, ODR, BSRR, BRR; } GPIO_TypeDef;
#define GPIOA_BASE ((intptr_t)0x0001)
typedef struct { void *unused; } TIM_TypeDef;
typedef struct { void *unused; } TIM_OCInitTypeDef;
typedef struct { void *unused; } TIM_ICInitTypeDef;
typedef struct { void *unused; } DMA_TypeDef;
typedef struct { void *unused; } DMA_Channel_TypeDef;
typedef struct { void *unused; } DMA_InitTypeDef;
typedef struct { void *unused; } SPI_TypeDef;
typedef struct { void *unused; } I2C_TypeDef;
typedef struct { void *unused; } USART_TypeDef;
typedef struct { void *unused; } ADC_TypeDef;
#define USART1 ((USART_TypeDef *)0x0001)
#define ADC1 ((ADC_TypeDef *)0x0001)
