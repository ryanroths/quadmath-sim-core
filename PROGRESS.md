# PROGRESS: quadmath-sim-core

Append only. Newest entry at the bottom. Never rewrite history, including the
parts where something went wrong.

Standing rules (owner, 2026-10-21):

- Stop at the end of every phase for the owner to fly. Do not start the next
  phase until the owner says go.
- The controller is ported, not written. If a Betaflight behaviour is missing,
  compile more Betaflight. Never reimplement rates, PID, filters, FF, TPA,
  iterm relax, airmode or anti-gravity in JS or in our C.
- Betaflight sources are read-only. All changes are patch files.
- Physics never reads frame time: a 1000 Hz accumulator, and render interpolates.
- No `Math.sin`/`cos`/`pow` in the physics path. Determinism is a requirement.
- Never change a test threshold to pass. Argue it here instead.
- Every phase appends here, including what went wrong.
- WebFPV: write ours, read theirs freely, never paste. Copying a function is
  not allowed. Reading WebFPV's glue for the HAL stub list is allowed. The
  black-box comparison is the test.

Paths: `~` is `C:\Users\Risfo`. The WebFPV reference clone is `~/webfpv-upstream`
(local branch `sim/bf-wasm-phase0`, never pushed). Phase 0 scratch is
`~/webfpv-phase0`. Citations into WebFPV say "WebFPV" and give its repo-relative path.

---

## 2026-10-21 | decisions | where sim-core lives and what it owns

- **Repo:** new GPLv3 (GPL-3.0-or-later, matching Betaflight) repository
  `ryanroths/quadmath-sim-core`, public source.
  - The question of whether quadmath's `sim.html` falls under the GPL is
    deferred to a lawyer. It is flagged in `NOTICE`; nothing blocks on it.
- **WebFPV clone:** kept at `~/webfpv-upstream` for black-box comparison only.
  Its branch stays local.
- **Phase 0 log:** moved here from the WebFPV clone's local branch
  (commits `2b10cde`, `04a018e`), with the flight added.
- **Plant:** port only the plant from quadmath's `quadphysics.js` (motors,
  RPM to thrust and torque, sag, drag, rigid body). Delete its PID, rates and
  FF; Betaflight owns those.
- **Config:** compile Betaflight's CLI `set` parser and settings table.
  - `profile`, `rateprofile`, `feature`, `resource` and `serial` lines in a
    diff must be applied, or rejected with a logged warning.
  - They are never silently dropped. That is a test.

---

## 2026-10-21 | Phase 0 | WebFPV run as-is: byte-exact on emsdk 3.1.61, verify 19 of 19, flown

### Pins

- WebFPV `518846c` (2026-10-21 23:36 UTC). Its `vendor/betaflight` is at `77d01ba` (tag 4.5.1).
- WebFPV committed `dist/sim.wasm`: 153,709 B,
  sha256 `08e995cb51e0cb95dc737daf4c5d57cce22c4959546fbdf234aa90ebea18ff69`.
- WSL2 Ubuntu 26.04 / kernel 6.18. emsdk `~/emsdk` (WSL home):
  - `latest` (emcc 6.0.13, `e13ee98`)
  - **3.1.61 (`67fa4c1`), active**
- Windows: Node 24.21.0, Git 2.54.0, Chrome at `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`.

### Results

1. **Clone.** Used `git -c core.autocrlf=false clone --config core.autocrlf=false --recurse-submodules`.
   - The system gitconfig sets `autocrlf=true`, which would have put CRLF into
     what WSL reads. The submodule config is also set to `autocrlf=false`.
   - Worktree line endings match the index for every Betaflight file.
2. **Serve.** `node scripts/serve.js` serves `http://127.0.0.1:8000/` and reaches the title menu in about 13 s.
   - `__shellReady === true`; `__craft()` reads module 0 at 0.71 kg.
   - Console: only `Failed to load resource: net::ERR_CONNECTION_REFUSED` to
     `127.0.0.1:3100/api/*` (WebFPV's board and stats backend, not run locally).
3. **WSL build** from `/mnt/c/Users/Risfo/webfpv-upstream`: `bash scripts/build-wasm.sh`.
   - **emcc 6.0.13 (`latest`):** exit 0, vendor diff empty, but 160,994 B
     `25a6b3dc...`, **not byte-exact**.
     - Diff: +3 functions, code +4,837 B, data +2,270 B, a new
       `target_features` section, and exports `setThrew` and `strerror`.
     - Replay trace hashes identical to the committed module's (configA @ 60
       and 144 Hz, config-rates-b). WebFPV's own log records the same pattern
       for an emcc 6.0.8 rebuild (WebFPV `PROGRESS.md:15245-15253`).
   - **emcc 3.1.61:** exit 0 in 15 s, vendor diff empty, 153,709 B
     `08e995cb...`, **byte-exact**.
     - The sha256 matches in WSL, and `cmp` against `git show HEAD:dist/sim.wasm`
       matches on Windows. Gate passed.
4. **`npm run verify`: 19 of 19, exit 0, 89 s.**
   - Run on Windows. Check 1 built through a PATH-only `emcc` shim
     (`~/webfpv-phase0/emshim/emcc`) that forwards into WSL emsdk 3.1.61.
   - The rebuilt module was `08e995cb...` again. Log: `~/webfpv-phase0/verify-3.1.61.log`.

   | # | check | measured |
   |---|---|---|
   | 1 | build-clean | exit 0, vendor diff empty, abi 1, init OK |
   | 2 | determinism-repeat | cbcf8c24bde7 = cbcf8c24bde7 |
   | 3 | determinism-cross-host | node = chrome = cbcf8c24bde7 |
   | 4 | frame-independence | 1 hash across 30/60/144/240 Hz |
   | 5 | hover-throttle | 0.2793 |
   | 6 | punch-out | 80.0 m |
   | 7 | terminal-velocity | 31.0 m/s |
   | 8 | motor-step-response | 26 ms |
   | 9 | rate-tracking | 672.1 vs 670 deg/s (0.32 %) |
   | 10 | yaw-coupling | -0.10 deg |
   | 11 | battery-sag | 11.18 % (26157 vs 23233 rpm) |
   | 12 | diff-passthrough | 1.2456 vs 1.2537 (0.65 %) |
   | 13 | console-clean | 0 errors, 0 warnings |
   | 14 | audio-bed | running, gain 0.100, 2.51 s, 44 nodes |
   | 15 | world-scale | all bands in (gate 1.7526 m, kerb 0.135, door 2.05, boom 1.24, cover 0.705) |
   | 16 | map-isolation | 0 city modules on field, 72 after; field cost unchanged after round trip |
   | 17 | world-golden | 36 of 36 bit identical |
   | 18 | crash-pacing | 48 of 48 |
   | 19 | crash-bounce | 20 of 20 |

5. **Flight (owner, TX16S): "Their build flies great, very locked in."**
   - **This is the reference feel for sim-core.**
   - Airframe, tune and Weight setting for this flight were not recorded;
     the owner may append them.
   - (Correction: an earlier plan in chat had this flight skipped. It was flown.)

### The network that WebFPV checks 14, 15 and 16 need

- These checks boot the real shell through WebFPV `scripts/shots.js` and `tests/lib/page.js`.
- Chrome's requests to `https://cdn.jsdelivr.net/*` are paused with the
  DevTools Fetch domain (WebFPV `tests/lib/page.js:274`) and answered by
  Node, which needs **outbound HTTPS to cdn.jsdelivr.net**.
- What Node fetches: three.js `0.160.0` (1.27 MB) and 9 addon modules.
- Cached at `%TEMP%\webfpv-cdn` (override `SIM_CDN_CACHE`, `page.js:45`): 10 files, 1.3 MB.
- Offline with an empty cache, 14 to 16 fail. The `127.0.0.1:3100` board calls
  are refused and are not needed.
- WebFPV's own last 17 of 19 (WebFPV `PROGRESS.md:71251`) was a city
  `until` timeout in their container. All 19 pass here. 17 of 19 is accepted
  as the floor when the CDN or the machine is slow.

### WebFPV airframe inventory (WebFPV `src/native/plant.c`, cross-checked against the live module's memory)

The module has exactly two airframes, `SIM_AIRFRAME_5IN = 0` and
`SIM_AIRFRAME_WHOOP65 = 1`.
- `SIM_AIRFRAME_COUNT 2`: WebFPV `src/native/sim_internal.h:177-179`,
  `src/native/sim_abi.h:374-375`.
- `sim_set_airframe(2)` is refused. There is no third airframe, and no 75 mm.

| | 5inch (row at plant.c:151) | whoop65 (row at plant.c:425-541) |
|---|---|---|
| mass | 0.710 kg | 0.023 kg |
| inertia xx/yy/zz (kg m^2) | 0.0035 / 0.0038 / 0.0068 | 6.0e-6 / 7.4e-6 / 1.25e-5 |
| wheelbase | 220 mm (arm 0.0778 m per axis) | 65 mm (arm 0.02298 m per axis) |
| prop | r 0.0635 m (5 in), 4.3 in pitch, 3-blade per comment | r 0.0155 m (31 mm), 0.8 in pitch, 3-blade per comment |
| kt / kq | 1.98e-6 / 3.04e-8 | 5.2e-9 / 2.85901e-11 |
| figure of merit | 0.520 | 0.305 |
| ke, KV | 0.006336, 1507 kV loaded (2207 1900 kV nameplate; plant.c:114-118) | 3.41046e-4, 28,000 kV (0702, the plate, plant.c:433) |
| winding R | 0.1825 ohm | 0.240 ohm |
| rotor J | 8.0e-6 kg m^2 | 1.5e-8 kg m^2 |
| cells | 6S | 1S |
| IR | 2.5 mOhm per cell, 15 mOhm pack | 30 mOhm cell to board (sags to about 3.65 V on a punch) |
| tau_mech = J R / ke^2 | 36.4 ms | 31.0 ms |
| tau linearised at hover | 28.8 ms | 22.3 ms |
| documented tau | ~34 ms (plant.c:129) | 22 ms (plant.c:417) |
| measured t63, check 8 method | 26 ms | 21 ms (one motor), 25 ms (all four) |
| hover at 4.0 V/cell, check 5 method | 0.279 (config-baseline) | stick 0.337 config-baseline, 0.373 whoop-champion; duty 0.337 both |
| hover at WebFPV shell defaults | 0.369 (gravity 1.62, air 1.1, kv 1.0) | 0.410 (gravity 1.0, air 1.0, kv 0.9) |
| drag cda plan/front/side (m^2) | 0.0225 / 0.0104 / 0.01176 | 0.00253 / 0.00084 / 0.00092 |
| ground effect `k_ground` | 0 | 1.0 |
| duct | no | `ducted = 1`; duct terms neutral (`k_duct` 1.0, fade 0, lip 0) |
| len_scale | 1 | 3.4289 (real metres in, room metres out) |
| motor direction | props-in `{-1,1,1,-1}` (shared) | same |

- All plant numbers are compiled into WebFPV's `PLANT_TABLE`.
- Runtime knobs:
  - `sim_set_airframe(0|1)`
  - `sim_set_motor_kv` (0.8 to 1.2)
  - `sim_set_cell_voltage`
  - `sim_set_gravity` (0.5 to 2.5)
  - `sim_set_air` (0.5 to 2.0)
- WebFPV's shell flies the 5inch at **gravity 1.62 × Weight** (Weight 60 to 140,
  so Weight 60 ≈ 0.97 g), air 1.1. The whoop flies at kv scale 0.9
  (effective 25,200 kV, R 0.296 ohm).

### Found: WebFPV's whoop plant diverges under its check 8 method

- **Setup:** motor 0 at full duty, the other three held at 0 (both
  whoop-champion and config-baseline).
- **What happens:** RPM holds at about 77.9k, then 601-605 ms after the step
  rpm0 jumps to 6.6e7 and later 1.3e27. One 1 ms step then takes 0.1 to 6 s
  of wall time. Deterministic.
- **What stays stable:** all four motors at full, WebFPV's own W7 whoop test,
  and the 5inch.
- **Cause:** ground effect is ruled out (no ground plane in the run, and the
  term is gated and capped). Body rates at divergence were about -6.7e3,
  1.28e4 and -2.0e3 rad/s.
  - Hypothesis, unverified: nothing bounds the body rate at that extreme.
  - It is a harness edge, not a feel defect.
- **For us:** sim-core's plant gets a divergence guard and a single-motor
  step test on every airframe (see the Phase 1 test list).

Scripts: `~/webfpv-phase0/t63whoop.mjs`, `t63probe.mjs`.

### WebFPV reset drift: fixed at the HEAD we ran

- WebFPV `patches/0004` (WebFPV `PROGRESS.md:71454`) fixes the reset drift.
- `npm run lint:reset` ran here: 8 of 8 bit for bit.
- sim-core still reinitialises from bytes (Phase 1 plan).

### Corrections made during Phase 0

- The brief said 14 checks; WebFPV has 19.
- WebFPV's Firmware bench cannot paste or upload CLI text (WebFPV
  `src/ui/fc.js:13-17`).
  - A diff reaches its 5inch only through `localStorage['webfpv.fc.v1.5inch']`
    plus the Tune row's "Your edits". Tested.
  - Its diff rates are replaced by its Rates menu, and `profile` lines are ignored.
  - `yaw_motors_reversed = ON` makes the yaw run away on its props-in plant.
  - A rejected dump falls back silently to the default tune.
- An adversarial claim check reported upstream pins of 3.1.73 and 4.0.x and
  a 6.0.10 rebuild. None exist; 3.1.61 is the only pin.
- An inventory reconciler reported a wrong whoop (28 g, 24,000 kV, 60 mOhm,
  0.45 FM, duct x1.15). The table above is from source and live memory.

### What went wrong

- The Phase 0 branch was first created in the quadmath clone by mistake. It
  was moved to the WebFPV clone; quadmath went back to `main` exactly as found.
- A background-shell wrapper orphaned the first clone, which had to be redone.
  Two task-monitor events reported states the files contradicted. Progress
  was trusted only from direct checks after that.
- emsdk `latest` was installed before reading upstream's pin, and was not byte-exact.
- Two subagent syntheses produced confident wrong numbers. Every number here
  was re-read from source or re-measured.

---

## 2026-10-21 | Phase 1 plan | sim-core: Betaflight 4.5.1 in WASM, quadmath's plant, our own glue (FOR REVIEW, no code yet)

Status: plan only. Nothing below is implemented. It stops here for owner review.

This is revision 2. An adversarial review of revision 1 (four reviewers, 55
findings) changed it materially. The review and how each finding was resolved
are at the end of this entry.

### Sources

Every fact in this plan was checked against source or a measurement.
- **Betaflight:** the 4.5.1 tree at `77d01ba`.
- **quadmath:** `origin/main` at `de9b15d`, exported read-only to
  `~/webfpv-phase0/quadmath-origin-main/`. The local quadmath checkout is 68
  commits stale and was not used.
- **WebFPV:** read for facts only, never pasted.
- **Artifacts:** `~/webfpv-phase0/phase1-research/` (scripts, raw `nm`,
  logs), with reports in `_results/`.

Betaflight paths here are relative to `src/main/`. quadmath short names:

| short | file |
|---|---|
| QP | `quadphysics.js` |
| H | `sim.html` |
| W | `sim-whoop.js` |
| B | `sim-build.js` |
| R | `sim-rates.js` |
| D | `sim-3d.js` |
| Rt | `sim-retention.js` |
| Tk | `sim-tracks.js` |

### What sim-core is

- A WebAssembly module plus `sim-core.js`, replacing **only** quadmath's
  physics core.
- **Betaflight owns** every controller behaviour it compiles: rates, RC
  smoothing, FF, PID, iterm relax, anti-gravity, d_min, TPA, throttle boost,
  airmode, angle/horizon, filters, mixer, idle, arming, failsafe and battery
  measurement.
  - The exceptions are what `SIMULATOR_BUILD` compiles out (see Decision 10).
- **sim-core owns** the clock, the hardware stubs (HAL), the tick that drives
  Betaflight's own task functions, the plant, world contact and the JS API.
- **quadmath keeps** render, OSD, ghost replay, audio, gamepad calibration
  and class presets (presets now become a plant parameter set plus a
  Betaflight diff per class).

### Repo layout (`ryanroths/quadmath-sim-core`)

```
vendor/betaflight/        submodule, Betaflight tag 4.5.1 (77d01ba), read-only
patches/                  ours, applied by build.sh to a COPY under build/bf/
                          (never to vendor/); see "Patches"
target/QMSC/              target.h, platform_mcu.h, timer_def.h (empty), dma_reqmap_mcu.h (empty)
src/glue/                 clock, HAL stubs, boot, tick driver, CLI port, ABI exports (C, ours)
src/plant/                plant, battery, current, world contact, triggers (C, ported from quadmath JS)
src/js/sim-core.js        JS API (ES module)
scripts/build.sh          the only build entry point
scripts/bf-sources.txt    the exact Betaflight file list
dist/sim-core.wasm        committed; dist/sim-core.wasm.sha256 beside it
tests/                    Node + headless Chrome harness
tests/reference/          WebFPV black-box metrics; a frozen copy of the quadmath JS plant for P2
```

### Byte-exact build on emsdk 3.1.61

- **Version gate.** `scripts/build.sh` refuses to run unless `emcc --version`
  reports `3.1.61 (67fa4c16496b157a7fc3377afd69ee0445e8a6e3)`.
- **Steps:**
  1. Copy `vendor/betaflight/src/main` and `lib/main/dyad` to `build/bf/`.
  2. Apply `patches/*.patch` there, in order.
  3. Compile the files listed in `scripts/bf-sources.txt`, then our glue and plant.
- **Compile flags.** Every path is **relative** to the repo root (the research
  build used absolute paths, which must not reach the real one):
  - `-std=gnu17 -O2 -fno-fast-math -ffp-contract=off -ffunction-sections -fdata-sections -fblocks`
  - `-DCLOUD_BUILD -D_GNU_SOURCE -D__TARGET__="QMSC" -D__REVISION__="77d01ba" -D__FORKNAME__="betaflight"`
  - `-DSIMULATOR_BUILD` (Decision 10)
  - `-I build/bf/src/main -I target/QMSC -I build/bf/lib/main/dyad`
  - no `-g`
- **Timestamps.** `SOURCE_DATE_EPOCH` is fixed, because `build/version.c`
  embeds `__DATE__`/`__TIME__`.
- **Link:** `--no-entry -sSTANDALONE_WASM=1`, with an explicit export list.
- **Gates:** two clean builds byte-identical; rebuild equals committed
  `dist/sim-core.wasm` sha256; vendor tree untouched (`git status --porcelain`
  empty). The research already rebuilt all 99 objects byte-identical.

### Patches (Betaflight is read-only; every change is a patch file)

Revision 1 used a shadow header and a forced include. Those change Betaflight's
behaviour outside patch files, so they are now patches:

- **`0001-keep-dyn-notch-in-simulator-build.patch`** (`target/common_post.h:494-497`).
  - Stops `SIMULATOR_BUILD` from undefining `USE_DYN_NOTCH_FILTER`. The stated
    `arm_math` reason is stale; 4.5.1 uses `common/sdft.c`.
  - Its settings then exist and apply. It is still inert at a 1 kHz loop
    (Decision 2).
- **`0002-pg-sections-for-wasm-ld.patch`** (`pg/pg.h:76-82`).
  - Gives the PG registry/reset-data sections identifier names, so wasm-ld
    synthesises `__start_*`/`__stop_*`. Betaflight uses a GNU ld script for
    this, which wasm-ld does not support.
  - Proven by the research link test: 39 registries, `pgResetAll` OK.

There are no behaviour patches for reset. WebFPV needed 0002-0004 because it
reuses an instance; sim-core reinitialises from bytes.

### Exact Betaflight file list (99, plus 2 to try in M1)

The research compiled these 99 with 0 errors and 6 `-Wsign-compare` warnings,
all in Betaflight's own code.
- All are blob-identical to `4.5.1:src/main/<f>`.
- A Node link test found 39 PG registries and 305 settings with **0 lacking
  a PG owner**.

| Area | Files |
|---|---|
| fc (7) | `core.c`, `rc.c`, `rc_controls.c`, `rc_modes.c`, `runtime_config.c`, `controlrate_profile.c`, `rc_adjustments.c` |
| flight (9) | `pid.c`, `pid_init.c`, `mixer.c`, `mixer_init.c`, `imu.c`, `failsafe.c`, `rpm_filter.c`, `dyn_notch_filter.c`, `position.c` |
| sensors (9) | `gyro.c`, `gyro_init.c`, `acceleration.c`, `acceleration_init.c`, `boardalignment.c`, `initialisation.c`, `battery.c`, `voltage.c`, `current.c` |
| common (12) | `filter.c`, `maths.c`, `sdft.c`, `bitarray.c`, `sensor_alignment.c`, `crc.c`, `streambuf.c`, `printf.c`, `printf_serial.c`, `typeconversion.c`, `string_light.c`, `strtol.c` |
| config (5) | `config.c`, `config_eeprom.c`, `config_streamer.c` (RAM image), `feature.c`, `simplified_tuning.c` |
| cli (2) | `cli.c` (whole), `settings.c` |
| drivers (6) | `motor.c`, `dshot.c`, `accgyro/accgyro_virtual.c`, `buf_writer.c`, `serial.c`, `light_led.c` |
| io (2) | `serial.c`, `beeper.c` |
| msp (1) | `msp_box.c` |
| rx (2) | `rx.c`, `msp.c` (RX_MSP: sticks enter here) |
| build (3) | `debug.c`, `version.c`, `build_config.c` |
| pg (41) | `pg.c` and all 40 `pg/*.c`, as Betaflight's `source.mk` does (29 are empty objects) |

**M1 tries `scheduler/scheduler.c` and `fc/tasks.c`** ("compile more Betaflight").
- `scheduler.c` failed in research only for `SCHEDULER_DELAY_LIMIT`, which
  Betaflight defines per MCU (`drivers/stm32/platform_mcu.h:190`). Our
  `platform_mcu.h` will define it.
- If both compile, the tick drives Betaflight's own task bodies through
  `schedulerExecuteTask` (`scheduler.h:244`), with Betaflight's `tasksInit`
  enables and rates:
  - `taskUpdateRxMain`'s RX state machine (`tasks.c:182-245`)
  - `taskUpdateAccelerometer`
  - the battery tasks
- Fallback, only if they cannot compile: glue calls the same public
  functions in `tasks.c`'s order, recorded here as a deviation.

Left out:
- `fc/init.c`: our boot calls the compiled subsystems' inits in `init.c` order.
- `drivers/accgyro/gyro_sync.c`: it hard-codes 8 kHz; we stub its function.
- `dshot_command.c`: needs DMA.
- `drivers/dshot_dpwm.c`: hardware; `useDshotTelemetry` is defined in glue.

### Target (`target/QMSC/`)

**`target.h` defines**

| Group | Defines |
|---|---|
| Identity and platform | `TARGET_BOARD_IDENTIFIER "QMSC"`, `SYSTEM_HSE_MHZ 0`, `DEFAULT_CPU_OVERCLOCK 0`, `U_ID_0..2`, `USABLE_TIMER_CHANNEL_COUNT 0`, `DEFIO_NO_PORTS`, empty `DMA_*` placement macros |
| Sensors | `USE_ACC`, `USE_VIRTUAL_ACC`, `USE_GYRO`, `USE_VIRTUAL_GYRO` |
| Motor output and filters | `USE_DSHOT`, `USE_DSHOT_TELEMETRY`, `USE_DSHOT_TELEMETRY_STATS`, `USE_RPM_FILTER`, `USE_DYN_IDLE`, `USE_DYN_NOTCH_FILTER` (kept alive by patch 0001) |
| Battery | `USE_ADC`, **`DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC`**, **`DEFAULT_CURRENT_METER_SOURCE CURRENT_METER_ADC`** |
| Config storage | `CONFIG_IN_RAM`, `EEPROM_SIZE 32768`, `FLASH_PAGE_SIZE 0x400` |
| Serial | `USE_UART1`, `SERIAL_PORT_COUNT 1` |
| Defaults | `DEFAULT_RX_FEATURE FEATURE_RX_MSP`, `DEFAULT_FEATURES 0` |

Without the two battery source defines, both meters default to NONE
(`sensors/battery.c:88-101`), and Betaflight would never read the plant's
battery.

`#undef` list:
- DShot: `DSHOT_BITBANG`, `DSHOT_DMAR`
- ESC sensor: `ESC_SENSOR*`
- `GYRO_REGISTER_DUMP`
- passthrough: `SERIAL_PASSTHROUGH`, `SERIAL_4WAY_BLHELI_BOOTLOADER`
- `RCDEVICE`, `MSP_OVER_TELEMETRY`, `VIRTUAL_CURRENT_METER`, `RX_MSP_OVERRIDE`
- `PERSISTENT_STATS`, `RTC_TIME`, `HOTT_TEXTMODE`, `CRAFTNAME_MSGS`, `TELEMETRY_SENSORS_DISABLED_DETAILS`
- CLI surface: `RESOURCE_MGMT`, `BOARD_INFO`, `SIGNATURE`, `SENSOR_NAMES`, `UNCOMMON_MIXERS`, `HUFFMAN`, `STACK_CHECK`
- buses: `VCP`, `I2C`, `SPI`

Not set: `SIMULATOR_MULTITHREAD` (no pthread).

**`platform_mcu.h`**
- no-op `__get_BASEPRI`/`__set_BASEPRI`/`__set_BASEPRI_MAX` (single thread, no interrupts)
- `__ASM`, `NVIC_PriorityGroup_2`, `extern SystemCoreClock`, `SCHEDULER_DELAY_LIMIT 100`
- opaque `TIM`/`DMA`/`SPI`/`I2C`/`USART`/`ADC` typedefs, plus `GPIO_TypeDef` with real fields
- `ADC1`, `USART1`, and the small enums Betaflight's headers expect

`-fblocks` is needed only for `build/atomic.h`'s block type declaration;
no blocks runtime is linked.

### HAL stub list (46 symbols left undefined by the 99 files)

| Group | Symbol(s) | Behaviour |
|---|---|---|
| Time | `micros` | Low 32 bits of an internal 64-bit µs clock (`t = tick × 1000`). |
| Time | `millis` | `(uint32)(t / 1000)`: its own counter, wrapping at 49.7 days like firmware `sysTickUptime`, not derived from the 32-bit µs value. Clock frozen during a tick. |
| Time | `delay`, `delayMicroseconds` | No-op; never advance the clock. Shutdown/serial-wait paths only. |
| System | `systemReset` | Sets `reboot_requested`; CLI processing stops. sim-core.js then reinitialises (Reinit policy). |
| System | `systemResetToBootloader` | Rejected with a logged warning. |
| System | `failureMode(code)` | Sets `fault = code`; `sc_step` returns early. |
| System | `SystemCoreClock` (data), `clockCyclesToMicros`, `stackHighMem`, `stackTotalSize` | Constants/0, for CLI `status` output only. |
| System | `timerGetConfiguredByTag` | NULL. Only zeroes beeper frequency and the N-channel flag (`config/config.c:511-550`); harmless. |
| Gyro | `gyroSetSampleRate` | Sets `gyroRateKHz`, **`accSampleRateHz = 1000`**, returns 1000. The real function sets acc rate as a side effect (`drivers/accgyro/gyro_sync.c:95`); without it `acc.sampleRateHz = 0`, the acc LPF is off, and `core.c:1006` divides by zero in angle mode. |
| Motor | `motorPwmDevInit` | Null device. Non-DShot protocols are rejected at config time. |
| Motor | `dshotPwmDevInit` | Our motor device: its write captures each motor's DShot value for the plant. Sets `useDshotTelemetry` from `dshot_bidir`. |
| Motor | `useDshotTelemetry` (data) | Defined in glue; normally in `drivers/dshot_dpwm.c`, which is not compiled. |
| Motor | `motors` (data), `dshotDMAHandlerCycleCounters` (data) | Storage / zeros. |
| Motor | `dshotCommandWrite` | Records `SPIN_DIRECTION_*` commands: the crash-flip path, issued only when 3D is off (`core.c:464-466, 529-539`). Others are logged and ignored. |
| Motor | `dshotStreamingCommandsAreEnabled` | True; otherwise boot-grace never clears (`core.c:280`). |
| Motor | `dshotSetPidLoopTime` | No-op. |
| ADC | `adcGetChannel(ADC_BATTERY / ADC_CURRENT)` | Counts from the plant's loaded pack voltage and current, inverting `voltage.c:167` / `current.c` with Betaflight's **default** `vbat_scale` and `ibata_scale`. |
| ADC | `getVrefMv` | 3300. |
| ADC | `adcDeviceByInstance` | ADC 1. |
| Scheduler | `getTaskDeltaTimeUs`, `rescheduleTask`, `getAverageSystemLoadPercent`, `schedulerIgnoreTaskExecTime`, `schedulerIgnoreTaskStateTime`, `schedulerResetTaskStatistics`, `getTaskInfo`, `getCheckFuncInfo`, `schedulerResetTaskMaxExecutionTime`, `schedulerResetCheckFunctionMaxExecutionTime`, `schedLoopStartCycles`/`taskGuardCycles` (data) | Resolved by compiling `scheduler.c` if M1 succeeds. Otherwise per-task period bookkeeping: `rescheduleTask` honoured (ATTITUDE 500 Hz in level modes, `core.c:1003-1010`); load 0; no-ops; zeros. |
| RX | `taskUpdateRxMainInProgress` | Resolved by `tasks.c` if M1 succeeds. Otherwise reflects the RX states. |
| Serial | `serTcpOpen` | NULL. |
| LED / IO | `warningLedFlash`, `warningLedDisable`, `warningLedUpdate`, `IOInit`, `IOGetByTag`, `IOConfigGPIO`, `IOToggle`, `IOWrite` | No-ops / NULL. |

Not stubs:
- linker: `__start/__stop_pg_registry`, `__start/__stop_pg_resetdata`
- toolchain: `__stack_pointer`, `__mulsc3`
- libc: `memchr memcmp memcpy memset strcat strchr strlen strncmp strtok_r`
- libm: `fmaxf fminf lrintf`

Our CLI `serialPort_t` vtable: `serialWrite`, `serialTotalRxWaiting`,
`serialTotalTxFree`, `serialRead`, `serialSetBaudRate`, `setMode`,
`writeBuf`, and `isSerialTransmitBufferEmpty`, which must return true
(`io/serial.c:612`).

### Two instance roles: config and flight

**cliEnter is never called on the instance that flies.**
- `cliEnter` sets `cliMode` and `ARMING_DISABLED_CLI` (`cli/cli.c:6775-6788`).
  Nothing in 4.5.1 clears that flag except a reboot.
- `cliMode` also stops `processRcAdjustments` (`core.c:966`).

So sim-core does what a pilot does with Configurator: open CLI, paste, `save`,
reboot.

1. **Config instance:**
   - Fresh instance → `sc_boot()` from the current EEPROM image → `cliEnter`.
   - Lines are applied one by one under the policy below.
   - `save` (`writeEEPROM`) → the new EEPROM image is copied out.
2. **Flight instance:**
   - Fresh instance → EEPROM image written in → `sc_boot()` → boot ticks.
   - `readEEPROM` → `featureInit`/`activateConfig` → `pidInit`,
     `initRcProcessing`, motor/DShot init, filters (`config/config.c:166-191,
     766-779`): **every applied line takes effect**, as on hardware.

This is why plain `set` (PG RAM only) is never the end of a configure. Every
`configure()` and every UI edit ends with save → reboot. UI edits are allowed
only while disarmed.

### 1 kHz tick (tick N, 64-bit `t = N × 1000 µs`, clock frozen during the tick)

Firmware order, checked in source:
- realtime tasks GYRO → FILTER → PID in one cycle (`scheduler.c:525-546`;
  `taskMainPidLoop`, `fc/core.c:1280`)
- then `rxFrameCheck` and, when `millis` has moved more than 10 ms, the
  failsafe block
- one non-realtime task per pass in the slack: RX (`tasks.c:182-212`),
  ACC 1 kHz, ATTITUDE 100 Hz or 500 Hz in level modes, battery

The tick:

1. **Data arrives.** This is what interrupts and DMA do on hardware.
   - Gyro: `virtualGyroSet(round(ω_deg/s × 16.384))`, clamped ±32767 (±2000 °/s).
   - Acc: `virtualAccSet(specific force body / g × 256)`; `acc_1G = 256`
     (`acceleration_init.c:413`). Specific force includes the **contact
     reaction**, so a quad at rest reads +1 g.
   - If `useDshotTelemetry`: per-motor eRPM = mechanical rpm × `motor_poles`
     / 2, encoded as Betaflight's raw period with `rawValueState = NOT_PROCESSED`.
     Betaflight's own decode and PT1 run on it (`dshot.c:292-333`).
   - ADC counts from the plant's pack voltage and current.
   - RX: if `t` is on the RX grid (250 Hz → every 4000 µs) and the link is
     up, `rxMspFrameReceive` gets the frame (sample and hold, below). Our
     `rcFrameTimeUsFn` returns `t`, so frame deltas are exact (`rx.c:1025-1043`).
2. **Realtime tasks:** `taskGyroSample(t)` → `taskFiltering(t)` →
   `taskMainPidLoop(t)`. These are public in `fc/core.h:82-86`.
3. **Every tick, as on the firmware:** `rxFrameCheck(t, …)` (`rx.c:503`),
   then the failsafe block when `cmp32(millis, last) > 10`.
4. **Slack tasks in a fixed, documented order when due**, through
   `schedulerExecuteTask` if M1 succeeds:
   - RX states CHECK → MODES → UPDATE in this tick, so a frame reaches the
     PID next tick (1-tick latency, as on the firmware)
   - ACC every tick
   - ATTITUDE at its current period
   - battery voltage / current / alerts at Betaflight's task rates

   Hardware picks among these by load; a fixed order is our deterministic choice.
5. **Plant.** It reads the captured DShot values and direction state, then
   integrates 1 ms: motors → forces → rigid body → world contact and triggers
   → battery and current. `N++`.

Boot asserts:
- `gyro.sampleRateHz == acc.sampleRateHz == 1000`
- `pid_process_denom == 1`
- DShot protocol
- ATTITUDE period 10000 µs in acro and 2000 µs in ANGLE
- acc LPF cutoff not zero

### Reinit policy

- **Every reinit is a new `WebAssembly.Instance`** from the cached `Module`,
  never `sim_reset` on a used one. No function-scope static can outlive a flight.
- **Carry-over set**, all re-sent after instantiation:
  - the EEPROM image (32 KiB `eepromData`, a global at
    `config/config_streamer.c:35`; sim-core exports its address)
  - plant parameters
  - world geometry
  - **battery state of charge and filtered voltage**
- A full map reset sends a fresh pack instead. quadmath keeps the charge
  across crash and last-gate respawns.
- **Boot runs until arm-ready:** `getArmingDisableFlags() == 0`, with sticks
  centred, throttle low, ARM aux low and the plant at rest on the spawn pose.
  - It covers `pwr_on_arm_grace` (5 s default, up to 30 s via a diff),
    gyro calibration, RC smoothing learning the frame rate, and battery cell
    count detection.
  - Cap: 35 s of ticks (35,000), else `fault`.
  - About 12-30 ms of CPU at defaults; to be measured.
- **What triggers a reinit:** respawn, crash reset, track restart, `save`,
  and a UI config edit.
- **What does not:** a portal teleport is a pose event at a tick boundary,
  triggered in C (see world triggers).

### Input: sim-time stamping and the RX frame

- **Sim time only.** `core.input(sample)` stamps each sample with the sim
  time of the next tick to run. Wall-clock time never enters the core.
  - Determinism is defined over the recorded sample stream in sim time.
  - Ghosts and I2 record that stream.
- **Integer channels.** A sample is 16 channel values 1000-2000:
  - AETR built through the **inverse of Betaflight's rcmap**, read back from
    the flight instance, so a diff's `map` line decodes correctly
  - AUX1-AUX12 passed through raw, so the pilot's own `aux` ranges and
    channels work
- **What quadmath sends.** The input layer maps radio channels 1:1 (a
  TX16S in joystick mode is a radio). Keyboard, touch and gamepad buttons
  are mapped to aux channel values. quadmath has no mode logic of its own.
- **RX frames are sample-and-hold** onto the 250 Hz grid. When the poll rate
  is below 250 Hz, frames repeat a value, and Betaflight's FF bridges only
  one duplicate. This matters for feel: **Decision 9.**
- **Link loss:** `sc_rx_link(0/1)` stops or resumes frames, so failsafe can
  be tested (F5).

### Config path

- **Pre-filter** (rejected lines never reach Betaflight):
  - strip CR
  - reject lines over 255 chars (`cli.c:6668` can overflow by one)
  - reject non-printable characters (`cli.c:6693` would drop them silently)
  - reject `?` (`processCharacterInteractive` treats it as completion and never stores it)
- **No `batch start`.** One `###ERROR` inside a batch blocks `save`
  (`cli.c:446-449, 4201`). Every line gets exactly one result:
  `applied | rejected(reason) | error(Betaflight's message)`.
  - Invariant: lines in = applied + rejected + errors.

| Command | Policy |
|---|---|
| `set` | Apply, except reject with a warning: HARDWARE_VALUE settings (`vbat_scale`, `ibata_scale`, `battery_meter`, `current_meter` and the like: board calibration, while sim ADC uses Betaflight defaults); sensor mounting and calibration (`align_board_*`, `gyro_*_align`, `acc_calibration`, `acc_trim_*`: sim sensors are already in the body frame); `motor_pwm_protocol` non-DShot; `pid_process_denom` ≠ 1. `yaw_motors_reversed` **applies**, and the plant's spin table follows it (props-out when ON). `dyn_notch_*` applies, with a logged "inactive below a 2 kHz loop" note. |
| `get`, `diff`, `dump` | Apply (config instance). |
| `profile`, `rateprofile` | Apply (scope the lines after them; the final one selects the active profile). |
| `feature` | Apply AIRMODE, ANTI_GRAVITY, MOTOR_STOP, 3D. Reject with a warning RX_*, GPS, RANGEFINDER, LED_STRIP, OSD, TELEMETRY and other peripherals. |
| `resource`, `timer`, `dma`, `serial` | Reject with a warning: no pins, no UARTs. |
| `aux` | Apply if `findBoxByPermanentId` finds the box and the channel ≤ AUX12. Otherwise reject (`cli.c:1223-1228` would keep a stale mode id, 0 = ARM). |
| `map` | Apply. sim-core builds frames through the inverse map. |
| `mixer` | Apply QUADX only; anything else is rejected with a warning. |
| `adjrange` | Apply; it works in flight because the flight instance is not in CLI mode. |
| `defaults nosave` | Apply. |
| `save` | Ends a configure (flight-instance reinit). |
| anything else | Reject with a warning. |

Default aux (Decision 7): if the applied config has no ARM box, sim-core adds
logged `aux` lines for ARM, ANGLE, HORIZON and FLIP_OVER_AFTER_CRASH on AUX1-4.

### Plant (C port of quadmath `origin/main` `de9b15d`)

A frozen copy of the JS plant code lives in `tests/reference/` for test P2.

| Part | Source |
|---|---|
| Motor spool | `out += (cmd − out)·dt/(τ + dt)`; τ × 0.73 up, then a further × 1.40 down (QP:275-306, 489-490). Effective whoop65 τ ≈ 9.5 ms up and 13.3 ms down; WebFPV's is 22 ms. |
| Thrust | `Tmax·sag·out²`, signed for reverse, reverse × 0.85 (QP:130, 294-303) |
| Yaw torque | `−dir·kQ·T·wb/2` (QP:305) |
| Roll/pitch torque | `pos × (0,0,T)` (QP:736) |
| Layout | quad-X d = wb/(2√2), Betaflight QUADX order (QP:425-433). Spin table props-in or props-out from `yaw_motors_reversed`. |
| Aero | body drag, disc drag, aero torque, floatiness `cdMul`/`aeroBMul`, `userDragMul` (QP:95-101, 205-254, 492-493; H:5199) |
| Extra gravity | the hook at H:3132-3136, as a `gravityMult` parameter |
| Ground effect | 1 + k(1 − h/D)² (QP:191-197, 720-727), with **h from a C port of the `groundClearance` query**: the highest world box top under the quad (H hook) |
| Rigid body | explicit Euler ω̇ = I⁻¹(τ − ω×Iω), first-order quaternion plus normalise, semi-implicit translation, g = 9.81 (QP:742-780); inertia box (QP:434-440) |
| World contact | floor brake (QP:762-768), floor clamp, AABB push-out, duct bounce (H:3161-3201, W:218-274). Contact produces a reaction force for the accelerometer and emits **events**. |
| World triggers | portal volumes evaluated per tick (was per render frame with a `performance.now` cooldown: a 9th frame-time leak) |
| Battery | OCV table, IR with SoC term, 0.15 s voltage filter, sag factor (V/Vfull)² floored at 0.45, drain (W:158-207); pack constants (B:211-227) |

Motor command decoding (DShot value → signed `cmd`):
- 0 = stop.
- Non-3D: 48-2047 → 0..1, direction from the last spin-direction command
  (crash flip).
- 3D (FEATURE_3D): 1048-2047 → forward 0..1, and 48-1047 → reverse 0..1,
  with 1047 as full reverse (`drivers/dshot.c:79-86`).

**Physics quadmath does not have.** These are new, listed for decisions,
and replaced by bench data in Phase 3:
- **RPM** (Decision 1): `rpm = |out| · KV · V_loaded`. It feeds DShot
  telemetry, the RPM filter, dynamic idle and audio.
- **Pack current and mAh** (Decision 3): `I = Σ (k_p · T_i^1.5) / V_loaded`,
  from ideal induced power scaled by a per-class figure of merit. quadmath
  has no current model at all; Betaflight needs current for the ADC current
  meter and sag compensation.
- **Freestyle classes** (Decision 12): `CLASS_REF` (B:13-26) covers only the
  65/75/85 mm classes (23000/22000/11000 kV). 2.5" and 5" need cells, mAh and
  KV placeholders. Their OCV table needs >2S support (W:160-178 is 1S/2S only).

Deliberate changes from the JS:
1. fixed 1 kHz
2. battery per tick with the same tick's load, carried across reinit
3. the RPM stand-in
4. motor direction from DShot (crash-flip commands; 3D value ranges)
5. disturbance off: propwash (default off, W:21) and draft noise
   (`performance.now()` every substep, H:3234); Decision 5
6. divergence guard: non-finite state or |ω| > 200 rad/s → `fault`
7. contact reaction force and contact events
8. portal triggers in C

**Physics inputs are deterministic numbers.** Every number that reaches the
plant is either a committed decimal literal or quantised at the ABI:
- **Preset tables:** `physicsFromBuild` (B:168-209, which uses `Math.pow`)
  is run once and its outputs are committed as literal tables. Custom builds
  use a C port of it.
- **World geometry and poses:** quantised to integer micrometres and 1e-9
  quaternion units, so a different JS engine's `Math` cannot leak in.
- **What B3 covers:** it checks only that the module imports no JS math
  functions; it does not cover these inputs.

Frame: quadmath's module frame (X forward, Y left, Z up). H:3101-3105
(WS = 3.5) stays the only render conversion.

### ABI

#### C exports (`sc_*`, version 1; int status, `SC_OK = 0`, unless noted)

| Export | Purpose |
|---|---|
| `sc_abi_version()` | Returns 1. |
| `sc_boot()` | Our init, in `fc/init.c` order for the compiled set, from the EEPROM image or defaults. Clock 0. |
| `sc_eeprom_ptr()`, `sc_eeprom_size()` | EEPROM image carry-over. |
| `sc_cli_enter()` | Config instance only. |
| `sc_cli_line(ptr, len)` | Result per line. |
| `sc_cli_log_ptr()`, `sc_cli_log_len()`, `sc_cli_log_clear()` | Read and clear the CLI log. |
| `sc_reboot_requested()` | Non-zero after a reboot path. |
| `sc_plant_set(f64 *params, int count)` | Plant parameter block v1 (fields below). |
| `sc_battery_carry(f64 *soc2)` | SoC and filtered voltage carried across a reinit. |
| `sc_world_clear()`, `sc_world_floor(z_um, restitution, friction)`, `sc_world_box(i32 *box_um, kind, id, restitution, friction)`, `sc_world_trigger(i32 *box_um, id)` | World geometry and triggers. |
| `sc_input(u16 *ch16)` | One 16-channel sample, stamped at the next tick. |
| `sc_rx_link(int up)` | Link up or down. |
| `sc_set_rx_rate(hz)` | 250, 500 or 1000. |
| `sc_pose(i32 *pos_um, i32 *quat_e9, i32 *vel_um_s)` | Pose event at the next tick boundary. |
| `sc_step(int ticks)` | Ticks run; stops early on a fault. |
| `sc_state_ptr()` | f64 state block v1, below. |
| `sc_fc_ptr()` | f64 Betaflight readouts v1, below. |
| `sc_events_ptr()`, `sc_events_len()`, `sc_events_clear()` | Event queue: contact begin (tick, kind, box id, normal and tangential impact speed), floor touch and leave, trigger enter (id), fault. |
| `sc_fault()` | 0, or the fault code. |

Plant block v1 (field order is the index; frozen at M4 with a test):
- **Body:** mass, Ixx, Iyy, Izz, wheelbase, propDiameter
- **Motor and thrust:** tmaxPerMotor, tauUp, tauDownMult, kQ, reverseThrustScale
- **Aero:** cdaXY, cdaZ, skin, aeroB, aeroC, discDragK, discDragChop0, floatiness, userDragMul, groundK
- **Environment:** gravity, gravityMult, airDensity
- **Battery:** cells, vFullCell, ocv[7], sagDrop, sagStrength, sagScale, vFilterTau, sagFloor, capacityMah, hoverSeconds
- **New physics:** kv, figureOfMerit, propsOut (set from Betaflight `yaw_motors_reversed` at boot)

State block v1:
- `t_us`
- `pos[3]`, `vel[3]`, `quat[4]`, `omega[3]`, `specificForce[3]`
- `motorDshot[4]`, `motorOut[4]`, `motorDir[4]`, `rpm[4]`, `thrustN[4]`
- `vbatLoaded`, `amps`, `mah`, `soc`
- `groundClearance`, `airborne`, `contactFlags`, `fault`

Betaflight readouts v1:
- armed, `armingDisableFlags`, `flightModeFlags` (ANGLE/HORIZON/AIRMODE/FLIP_OVER_AFTER_CRASH/3D), failsafe phase
- Betaflight's vbat, amperage, mAh drawn, cell count
- `setpoint[3]`, `gyroFiltered[3]`, `pidSum[3]`, `rcCommand[4]`, `motor[4]`
- `debug[8]`, `debugMode`

#### `sim-core.js` (the only thing quadmath imports)

```js
const core = await SimCore.load(urlOrBytes, { rxHz: 250 })
  // compile once; keep the Module
core.configure({ diff, plant, world, battery })
  // config instance → per-line report → save → flight instance → boot to arm-ready
  // → { lines: [{ n, text, status: 'applied'|'rejected'|'error', msg }],
  //     applied, rejected, errors, added }
core.input(channels16)          // one sample per input poll, stamped in sim time
core.link(up)
core.advance(frameDtMs)         // accumulator → whole ticks (cap 250 per call; more is a pause);
                                // returns ticks run. Physics never sees frameDt.
core.state; core.fc             // latest tick (SI, module frame) and Betaflight readouts
core.lerpState(alpha)           // render interpolation, alpha = accumulator / 1 ms
core.events()                   // drained per frame: contacts, triggers, faults
core.reinit({ freshPack })      // synchronous new Instance + carry-over + boot to arm-ready
core.teleport({ pos, quat, vel })
core.edit(lines)                // disarmed only: config instance → save → flight reinit; returns the line report
core.get(key); core.diff()      // from the config instance
core.rateCurve(axis, n)         // see below
core.fault; core.simTimeUs
core.traceHash()                // sha-256 over the state block AND the Betaflight readouts, every tick since boot
```

**Rate curve without JS rate math.** `rc.c`'s `applyRates` is `static`, so
`core.rateCurve` uses a **probe instance**:
- the same module, current EEPROM image, RC smoothing off
- for each stick deflection, feed a frame and read `getSetpointRate`
  (display only; it does not need to be bit-exact)

No rate formula lives in JS.

**Compat adapter** for code outside the physics path. It covers the full
consumer list from research (`qp-map` §1):
- **Reads:** `position`, `velocity`, `quaternion`, `omega`, `armed`
  (Betaflight), `airborne`, `motorOutputs`, `totalThrustN`,
  `totalThrustAbsN`, `twr`, `attitude` (from the quaternion, for the coach),
  `flightMode` (from Betaflight mode flags), `groundClearance`,
  `physicsHz` (constant 1000), `floatiness`.
- **Removed:** setters (`setTune`, `setFlightMode`, `setThreeD`, `arm`,
  `disarm`, `setPhysicsHz`, direct writes to `position`/`velocity`/`omega`/`armed`).
  Each caller changes to input channels, `teleport` or `reinit`.

### quadmath integration (a quadmath PR, human-override label, not merged by us)

1. **Swap the physics.** Replace `new QuadPhysics` (H:3107) with `SimCore`
   plus the adapter. `physics()` sends 16 raw channels per poll.
2. **Arming moves to Betaflight's ARM aux.**
   - Auto-arm (`stepAutoArm`, D:113-143) and the arm switch
     (`stepArmSwitch`, `sim-touch.js:758`) set the ARM aux channel value.
   - `tryArm`/`toggleArm`/`tickArming` (H:4088-4144) stop calling
     `qp.arm()` and stop forcing the physics rate.
   - Betaflight's arming checks decide; the OSD shows the arming-disable reason.
3. **Delete controller code**, by function, not line range. Exact edits are
   reviewed in M6.
   - QP: `DEFAULT_TUNE`/P-I-D-F constants, `RateAxis`, `LPF`,
     `flightSetpoint`, angle/horizon constants, mixer/airmode desaturation,
     FF window and input interpolation. The motor/thrust code moves to C.
   - D: `applyThrottleMidExpo`, `throttleCollective`, `mapThrottle3d`.
   - H: `STOCK_TUNES`, the rate conversion in `physics()`, the throttle
     curve, the CLI import into `setTune`.
   - R: `parseCli`, which drops non-`set` lines silently (R:373), and the
     rate formulas.
   - `sim-feel.js`: `RATE_PRESETS`, `modeFromAux`.
   - Touch expo stacking (`sim-touch.js:24`).
4. **Keep** (not controller): `throttleSafeToArm`, `parseThreeDQuery`,
   `runCountsForBoards`, `throttleHudText` (D); `loadInputChoice` and the
   other input-choice code in `sim-feel.js`; the R UI (it writes lines via
   `core.edit`, draws via `core.rateCurve`); `attitudeOf` as a coach readout.
5. **Per-class boot config.** Each class becomes plant numbers plus a
   Betaflight diff: class rates (exact, since R mirrors `rc.c`), `thr_mid 62`,
   and PIDs per Decision 11. `STOCK_TUNES` values are not Betaflight units
   and are not carried over.
6. **Frame-time leaks (9):**
   - (a), (b): gone with the controller.
   - (c): fixed 1 kHz, `adaptPhysicsHz` removed.
   - (d): battery in the core.
   - (e): turtle via Betaflight crash flip.
   - (f): draft noise off.
   - (g): run start, lap, split timers (H:1584-1586, 1603, 1681) and ghost
     timestamps (H:5828) **all on sim time**; a frame longer than 250 ms is a pause.
   - (h): input stamped in sim time.
   - (i): portal triggers in C.
7. **Render interpolation** with `lerpState(alpha)`; there is none today (H:4212).
8. **World export.** Each map exports floor, AABBs, ducts and portal volumes
   once, quantised. The `onSubstep`, `groundClearance`, `externalDrag` and
   `externalDisturbance` hooks retire.
   - Their side effects come back through `core.events()`: `coach.noteCrash`,
     `tricks.noteCrash`, `camShake` by impact speed, bounce sound.
9. **Ghosts and leaderboard.**
   - Bump `PHYSICS_VER` (W:11) and `PHYS_VER` (Rt:27) together.
   - The leaderboard Worker bundles `sim-retention.js`, so it deploys with
     the bump.
   - The daily path (Rt:1640) accepts ghosts with no `phys` field; only the
     weekly path (Rt:2691) is strict. The PR either makes daily strict or
     records why not.
10. **OSD:** BATT from Betaflight's vbat; arming-disable reason.
11. **Load path:** Decision 8.

### Tests (none of these thresholds changes to pass)

**Build**
- **B1 byte-exact:** two clean builds are identical, and the rebuild equals
  the committed sha256. A wrong emcc version refuses to build.
- **B2:** the vendor tree is unmodified; patches go only to `build/bf`.
- **B3:** the wasm import allow-list holds (no JS functions). Scope: imports only.
- **B4:** every `settings.c` value has an owning PG (0 missing).
- **B5:** every boot assert listed under the 1 kHz tick holds.

**Determinism**
- **D1 repeat:** the same sim-time sample stream twice gives the identical
  `traceHash` (plant state plus Betaflight readouts, every tick).
- **D2 Node vs Chrome:** identical `traceHash` in Node 24 and headless
  Chrome. Covers every class preset, acro and angle, RPM filter on and off,
  and 3D.
- **D3 frame independence:** one sim-time sample stream run with `advance()`
  cadences 30, 60, 144 and 240 Hz, plus seeded jitter, gives 1 distinct hash.
- **D4 reset vs fresh load:** flight → `reinit()` → flight B equals a fresh
  load (same carry-over, including battery SoC) → flight B.
  - 0 mismatching tick hashes.
  - Covers every preset, acro and angle, air and ground.
  - Modelled on WebFPV's `reset-check` idea, not its code.
- **D5 bad input:** non-integer channels or a decreasing order are rejected
  at the JS boundary. Non-finite plant state raises a `fault`, never NaN in
  Betaflight.

**Config**
- **C1 diff passthrough, runtime effect.** Checked on the **flight**
  instance after configure (save → reboot), not only with `get`:
  - changed rates move `getSetpointRate` at fixed sticks
  - a P change moves a step response
  - `dshot_bidir ON` activates the RPM filter
  - `yaw_motors_reversed ON` flies props-out without yaw runaway
  - an `adjrange` works in flight
  - `get` returns every `set` value as Betaflight formats it

  Corpus: `config-baseline`, `config-rates-b`, `betaflight-default`, the 3
  WebFPV whoop diffs, the owner's Air65 diff, and a 4.5.1 `diff all`.
- **C2 never silently dropped:** every line is applied, rejected with a
  reason, or errors with Betaflight's message. The corpus adds:
  - `profile`, `rateprofile`
  - `feature` good/bad, `resource`, `serial`
  - `aux` good, unknown box, channel > AUX12
  - `map`, `mixer`, `adjrange`
  - HARDWARE_VALUE and mounting keys
  - unknown commands and keys, out-of-range values, empty values
  - CRLF, lines over 255 chars, non-ASCII, `?`

  Invariant: lines in = applied + rejected + errors.
- **C3 profiles:** `profile 1` then `set p_roll` lands in profile 1; same for
  `rateprofile`. The final selector wins.
- **C4:** a rejected line never blocks `save`.
- **C5:** configure → reinit → `diff all` identical; a respawn keeps config.

**Betaflight behaviour**
- **F1:** the setpoint curve is bit-equal to WebFPV's at every stick quantum
  on the 1/500 grid, every axis and rate type.
- **F2:** the setpoint step trajectory equals WebFPV's after aligning our
  1-tick RC latency (theirs is 0).
- **F3:** achieved full-stick rate within ±1.0% of configured.
- **F4:** config readback is string-equal to WebFPV on their 177 keys that
  Betaflight also has. Where WebFPV is not Betaflight, sim-core asserts
  Betaflight's behaviour instead:
  - profiles
  - `p_roll = 251` stored
  - clamping
  - `launch_angle_limit = 40` default
  - `rpm_filter_weights_1/2/3` naming
- **F5 arming and failsafe:**
  - boot reaches `armingDisableFlags == 0` with no `ARMING_DISABLED_CLI`
  - the ARM aux arms
  - `sc_rx_link(0)` gives Betaflight's failsafe stages, and recovery
- **F6:** axis signs for roll, pitch and yaw.
- **F7:** the RPM filter is active exactly when `dshot_bidir` is on. Dyn
  notch settings apply and are inert at 1 kHz, with a logged note.
- **F8 battery:** Betaflight's vbat equals the plant's within 1 ADC LSB, cell
  count is correct, and `vbat_sag_compensation` changes motor range under load.
- **F9 3D:** full reverse stick gives reverse thrust, and the deadband gives zero.
  Crash flip reverses through spin-direction commands only when 3D is off.

**Plant**
- **P1:** single-motor step on every preset: no divergence; t63 reported.
- **P2 port parity:** the frozen JS plant (`tests/reference/`) and the C
  plant get identical motor-command sequences.
  - Trajectories agree within 1e-6 relative over 2 s; they cannot be
    bit-equal (JS `Math` vs C libm).
  - The 8 deliberate changes are switched off for this test.
- **P3:** battery sag matches `sim-whoop.js` per preset for the same load sequence.
- **P4:** a quad at rest on the floor reads +1 g ±1% on the accelerometer.
- **P5:** the C ground-clearance query equals the JS hook over a sampled
  grid on every map.

**Black-box vs WebFPV `08e995cb`** (reference from 2026-10-21, copied to `tests/reference/`)

Same input scripts, 250 Hz grid, no stick motion at t = 0 (WebFPV's first-frame
FF is 4.2× too large).
- **X1 exact:** F1, F2, F4.
- **X2 tight:** F3.
- **X3 feel bands**, pass/fail per metric. **Phase 1 exits only when X3 is
  green or the owner signs off each miss**, after reading its argued cause
  here (e.g. a plant difference). A band is never widened.

| Metric | Band vs reference, same scenario |
|---|---|
| Hover stick | ±0.03 |
| Roll/pitch rise 10-90% | ±20% (≥ ±4 ms) |
| Lag at 50% and chirp lag | ±3 ms |
| Overshoot, stop bounce | ±2 points |
| Settle ±5% | ≤ 1.5× |
| Yaw rise | ±30% |
| Yaw steady error | ±3 points |
| Chirp error after lag | ±3 points |
| Chirp gain | ±0.03 |
| Punch 1 s | ±15% |
| Coast | ±20% |
| Drift after roll | ≤ 0.5° in 5 s |
| Hands-off 8 s | ≤ 0.05° |
| Off-axis peak | ≤ 10 °/s |
| Divergence | none |

Reference values, 5" at gravity 1.0 / shell defaults:
- roll rise 41 / 40 ms
- overshoot 4.45 / 3.21 %
- chirp lag 10 / 7 ms

Reference values, whoop at gravity 1.0 / shell defaults:
- roll rise 23 / 21 ms
- chirp lag 4 / 5 ms

Full table: `phase1-research/_results/blackbox-ref.md`.

Expect X3 misses on the whoop: quadmath's spool τ (9.5 ms up / 13.3 ms down)
is about 2.3× faster than WebFPV's 22 ms, and masses differ (27 vs 23 g;
650 vs 710 g).

**Integration** (quadmath PR)
- **I1:** `sim.html` boots on sim-core with no console errors.
- **I2:** one recorded sim-time input session replayed at 30, 60 and 144 fps
  gives the same final hash.
- **I3:** both versions are bumped, the Worker is deployed with them, and
  ghost and lap timestamps are on sim time.
- **I4:** the OSD shows Betaflight vbat and the arming-disable reason.

### Owner decisions needed before code

1. **RPM stand-in** `rpm = |out|·KV·V_loaded` until Phase 3. *Recommend: accept.*
2. **Loop rate.** 1 kHz leaves dyn notch inert (it needs ≥ 2 kHz) and caps
   RPM notches at 480 Hz; whoop motors near hover sit around 500 Hz. Phase 1
   has no motor-noise model, so the filters only add their delay.
   *Recommend: keep 1 kHz, logged.*
3. **Battery through ADC, plus a new current model** `I = Σ k_p·T^1.5 / V`
   (placeholder). *Recommend: yes.*
4. **World contact, clearance and triggers move into C.** Required for
   determinism. *Recommend: yes.*
5. **Disturbance off in Phase 1.** Propwash and draft noise come back
   deterministically in Phase 2. *Recommend: yes.*
6. **3D in Phase 1** through Betaflight `feature 3D` and value-range
   decoding, tested by F9. *Recommend: yes.*
7. **Default aux lines** (logged "added") only when a diff has no ARM box.
   *Recommend: yes.*
8. **Load path.**
   - (a) A sim-core release URL pinned with SRI sha256, which keeps GPL
     bytes out of the quadmath repo.
   - (b) A vendored copy.
   - *Recommend (a)*, with a local dev override.
9. **Input poll rate.** quadmath polls the gamepad only in rAF. At 60 fps,
   about 3 of every 4 RX frames repeat a value, and Betaflight FF bridges
   one duplicate.
   - *Recommend:* also poll on a 250 Hz timer, still stamped in sim time,
     and measure FF behaviour.
   - Alternative: interpolate between polls, which adds 1 frame of latency.
10. **`SIMULATOR_BUILD`.** It compiles out:
    - yaw-spin detection and recovery (`gyro.c:371`)
    - the gyro overflow check (`gyro.c:312`)
    - the acc calibration requirement (`acceleration_init.c:119`)
    - *Recommend:* M1 tries a build without it; research saw `config.c`/`rx.c`
      fail only on MCU typedefs our `platform_mcu.h` can supply. If that
      fails, keep it and record these as known deviations.
11. **Class PIDs.**
    - Whoops: the owner's Air65 diff.
    - 2.5" and 5": Betaflight 4.5.1 defaults.
    - All classes: quadmath's class rates and `thr_mid 62`.
    - *Recommend: yes.*
12. **Freestyle placeholders until bench data.** quadmath has KV and cells
    only for 65/75/85 mm (B:15-23: 23000/22000/11000 kV, 1S/1S/2S).
    - 5": 6S, 1300 mAh, **1900 kV**, which is the nameplate motor WebFPV's
      5" models (2207 1900 kV, WebFPV `src/native/plant.c:53-104`) and keeps
      X3 comparable.
    - 2.5": **owner to supply** cells, mAh and KV.
    - OCV table extended to 6S.
    - *Recommend: accept the 5" values; owner gives the 2.5" values.*
13. **Frozen JS plant copy.** Commit a copy of the JS plant code (quadmath's
    own) into this GPL repo as the P2 reference. *Recommend: yes.*

### Risks and unknowns

- **Our boot replaces `fc/init.c`** for the compiled set. A missed step
  shows up in B4, B5, F5 or D4; the init order is reviewed in M2.
- **JS-to-C plant float differences.** P2 bounds them. Feel may shift a
  little; the owner flies it.
- **Boot length is config-dependent:** 5-35 s of ticks, at a few µs each.
  The respawn hitch is to be measured.
- **The comparison is against WebFPV's plant, not quadmath's.** X3 compares
  our quadmath-plant sim with it, so misses may be plant differences. They
  go to the owner, never to a wider band.
- **The owner's reference flight setup** (airframe, tune, Weight) is
  unrecorded, so X3 uses columns A-D.
- **The sim-time input stream** makes replays exact, but live feel still
  depends on poll rate (Decision 9).

### Order of work after go (stop after each milestone that changes feel)

1. **M1:** repo plumbing, submodule, target headers, patches 0001-0002,
   `build.sh` with the version gate. Try `scheduler.c`/`tasks.c` and a
   no-`SIMULATOR_BUILD` build. Everything links with stubs. B1-B4 green.
2. **M2:** clock, boot, two-instance config flow, CLI policy. B5, C1-C5,
   F4 green.
3. **M3:** tick, RX, sensors, motors on a rigid-body test plant. D1-D3,
   F1-F3 and F5-F9 green.
4. **M4:** quadmath plant port, contact, clearance, triggers, battery and
   current. P1-P5 and D4 green.
5. **M5:** `sim-core.js`, probe instance, Chrome harness, black-box suite.
   D2 and X1-X3 run; X3 misses argued here.
6. **M6:** quadmath PR (I1-I4). **Stop. The owner flies.**

### Adversarial review of revision 1 (2026-10-21)

Four reviewers looked at revision 1, each through one lens: Betaflight
correctness, determinism and build, quadmath integration, and compliance
with the owner's rules and asks. They produced 55 findings, kept in full in
`~/webfpv-phase0/phase1-research/_results/plan-review.json`. The ones that
changed the plan are below; each blocker was re-checked in source before
the fix.

**Blockers (fixed above):**
- **The CLI was left open in flight.** `cliEnter` permanently disables
  arming (`cli.c:6775-6788`; nothing clears `ARMING_DISABLED_CLI`) and
  turns off adjrange. Fixed by the two-instance flow.
- **`set` only writes PG RAM.** Runtime state is built at boot from the
  EEPROM image, and configure had no save. Fixed: configure always ends
  with save → reboot; C1 checks the runtime effect.
- **No time base for input timestamps.** Wall time against a sim clock
  that restarts every reinit. Fixed: sim-time stamping.
- **quadmath's arming paths were deleted without a replacement.** Fixed:
  auto-arm and the arm switch drive the ARM aux; Betaflight decides.

**Major (fixed above):**
- Battery meter sources defaulted to NONE (`battery.c:88-101`), so
  Betaflight never read the ADC: target defaults added.
- The `gyroSetSampleRate` stub left the acc rate at 0
  (`gyro_sync.c:95`): the stub now sets it.
- 3D direction is encoded in DShot value ranges, not commands
  (`dshot.c:79-86`, `core.c:464`): decoding specified, test F9 added.
- `yaw_motors_reversed` gave yaw runaway: the plant now follows it.
- The `map` line and aux semantics: inverse-map frames and raw AUX1-12
  replace JS mode flags.
- `SIMULATOR_BUILD` compile-outs were unlisted: now Decision 10.
- `tasks.c`/`scheduler.c` were left out on a wrong rationale: M1 now
  tries them.
- The shadow header and forced include changed Betaflight outside patch
  files: they are now patches 0001-0002.
- Physics inputs computed with JS `Math`: now committed literals or
  quantised; B3's scope stated.
- Battery state was lost on every respawn: it is now carried over.
- Mixed lap and ghost clocks: all on sim time. The leaderboard Worker
  bundles `sim-retention.js`; daily-path strictness noted.
- No per-class Betaflight config: now Decision 11.
- Deletion ranges hit non-controller code: now by function, with a keep list.
- Contact side effects were missing: event queue added.
- The `groundClearance` query lived in `sim.html`: ported, test P5 added.
- The compat adapter was incomplete: full surface listed.
- Freestyle classes have no KV or cells, and quadmath has no current
  model: now Decisions 3 and 12.
- The Rates UI needed JS rate math: replaced by the probe instance.
- Failsafe could not be driven: `sc_rx_link` added.
- X3 could not fail: it now gates Phase 1 exit unless the owner signs off.
- The frozen JS plant was needed for P2, but its code was on the delete
  list: frozen copy, Decision 13.

**Minor (fixed above):**
- `millis` wrap: independent counter.
- `rxFrameCheck` and failsafe ran before the gyro and only on the RX grid:
  moved to after the realtime tasks, every tick, as on the firmware.
- The HAL row count: `useDshotTelemetry` added.
- `?` and aux channel range: pre-filter.
- Fixed 6000 boot ticks: boot until arm-ready, capped at 35 s.
- Kinematic floor contact gave 0 g on the accelerometer: reaction force
  added, test P4.
- `traceHash` covered only the plant: it now includes the Betaflight readouts.
- The portal was a 9th frame-time leak: trigger moved into C.
- Whoop τ was misquoted: corrected to 9.5 ms up / 13.3 ms down.

**What went wrong:** revision 1 read the research too optimistically. It
treated "compiles and links" as "runs like firmware", which hid the CLI
arming lock, the PG-RAM-only `set`, and the NONE battery meters. Running the
four-lens review before showing the plan caught them.

**Also went wrong: workflow completion notices.** During this research, at
least six "workflow completed" notices arrived before the work had finished.
Their journals held no results. Two carried detailed but fabricated content:
- a `qp` map with wrong line numbers and invented presets ("fiveInch",
  "toothpick3", whoop 34 g, "KV 1950")

Nothing from them was used. Every result above was read from the workflow
journals and checked against source.

Rule from here: never act on a completion notice until the journal shows the
result.

---

## 2026-10-22 | decisions | owner answers to the Phase 1 plan

**Repo.** Pushed public to `https://github.com/ryanroths/quadmath-sim-core`
(`main` at `ab64c0a`). The SSH push was refused; the remote uses HTTPS.

### Owner decisions (verbatim intent)

- **RPM (plan decision 1, replaced).** Build the minimum real model now:
  RPM = KV × effective voltage, with first-order motor lag, loaded by prop
  drag torque.
- **Current (part of plan decision 3, replaced).** Bench mAh/min per class,
  as a throttle-proportional stand-in until Phase 3.
- **Loop rate (plan decision 2).** 1 kHz, as a build parameter
  (`SC_LOOP_HZ`), not hard-coded.
- **Gamepad (plan decision 9).** A 4 ms `setInterval` poll, stamped in sim
  time, into a ring buffer. Betaflight's RC link rate is set to match
  (250 Hz). WebHID is Phase 2.
- **Per-class PIDs (plan decision 11).** Real diffs only:
  - 65 mm: the Air65 diff from `tune-database.js`
  - 75 mm: the Meteor75 Pro diff from `tune-database.js`
- **Drop 2.5" and 5" from Phase 1 (plan decision 12).** No preset without
  a real diff and bench data.
- **Remaining decisions:** take the recommended pick, log it, and flag any
  with less than high confidence.
- **Next step:** start Phase 1 code, and stop at the first point where
  Betaflight arms and a motor responds to a stick in Node, before any
  browser work.

### Remaining decisions taken (recommended pick)

| Plan decision | Pick | Confidence |
|---|---|---|
| 3 Battery through Betaflight's ADC (`USE_ADC`, voltage and current meter sources ADC) | yes | high |
| 4 World contact, clearance and triggers in C | yes | high |
| 5 Disturbance (propwash, draft noise) off in Phase 1 | yes | high |
| 6 3D mode in Phase 1 (`feature 3D`, DShot value-range decoding, test F9) | yes | **medium**: adds reverse-thrust plant work and a test; it could move to Phase 2 without hurting anything else |
| 7 Default `aux` lines when a diff has no ARM box | yes | high. Note: every `tune-database.js` export has no `aux` lines, so this will fire for both classes. |
| 8 `sim.html` loads sim-core from a release URL pinned with SRI | yes | **medium**: depends on how the quadmath site is deployed and whether the release host is reliable; a vendored copy is the fallback |
| 10 Try building without `SIMULATOR_BUILD` in M1; if that fails, keep it and record the compiled-out behaviours | yes | **medium**: unknown until M1 compiles it |
| 13 A frozen copy of the JS plant in this GPL repo as the P2 reference | yes | **medium**: it is the owner's own code, so the owner's licensing call; low risk |

### Findings from the data that change or constrain these decisions (flagged)

1. **`tune-database.js` stores no full diffs.** Each card holds PIDs and
   rates as numbers, plus prose notes.
   - Its export `cliFor()` (`tune-database.js:365-385`) emits only:
     - `p/i/d` per axis
     - `rates_type`
     - `rc_rate`/`srate`/`expo` per axis
     - `save`
   - Everything else in the notes is not machine-readable: FF, D-min, TPA,
     filters, bidir DShot, dyn idle, thrust linear, `motor_poles`.
   - So the "real diff" for each class is a **partial** Betaflight diff;
     every other setting stays at the Betaflight 4.5.1 default.
   - **Confidence: low** that this matches the owner's intent. A full
     `diff all` from each quad would close it.
2. **Which Air65 card.** Two candidates:
   - `65-betafpv-ryfly-1219s` (RyFly, VCI Spark 0702 29K KV, Gemfan 1219S,
     board "AIR65 RYFLY"). This matches the only calibrated Air65 bench file,
     `data/bench/air65-analog-vci0702-30k.json` (VCI 0702 PRO DB 30000 kV,
     Gemfan 1219 3-blade, 300 mAh LiHV, 25.42 g).
   - `65-betafpv-stock` (factory Air65 II Champion, Champion 0702 and
     Gemfan 1207). It has no bench file.
   - **Picked `65-betafpv-ryfly-1219s`. Confidence: medium.**
3. **The Meteor75 Pro has a diff but no bench data.**
   - The only Betaflight 4.5.1 Meteor75 Pro card is
     `75-betafpv-ryfly-hamo-45mm` (1102 22K KV, 45 mm props).
     `75-betafpv-ryfly-o4-gf1811` is on BF 2025.12-alpha, not 4.5.1, so it
     is excluded.
   - All three 75 mm bench files are provisional: uncalibrated sensors,
     uncontrolled runs. All three are 0802 builds (Treetopper, Fractal,
     Cockroach), not a Meteor75 Pro.
   - Under "no preset without a real diff and bench data", **75 mm has no
     plant in Phase 1 yet**. Its diff is still used in config tests.
   - **Owner choice needed** (no confidence assigned):
     - fly a Meteor75 Pro bench run
     - or accept a provisional 0802 bench file
4. **85 mm is dropped too.** `85-happymodel-ryfly` (Mobula8 2S) has a diff
   but there is no 85 mm bench file. Same rule.
5. **The RPM model has no bench numbers for its constants.** The bench files
   carry KV, prop, pack, AUW and current/mAh only. There is no RPM, winding
   resistance, rotor inertia or thrust data.
   - Phase 1 therefore sets the lag time constant from quadmath's motor τ.
   - It sets the prop drag and thrust coefficients from quadmath's preset
     thrust and kQ at full speed.
   - **Confidence: medium** on the structure, **low** on the constants
     until a bench RPM/thrust run.
6. **Current reference point.** The calibrated Air65 cruise run gives 270 mAh
   (corrected) in 233 s: 4.2 A average, 69.5 mAh/min, ±8%.
   - The bench file records no throttle, so "throttle-proportional" needs a
     reference duty. Phase 1 uses the plant's own hover duty as the cruise
     reference.
   - **Confidence: low.**
7. **What the first stop needs.** The stop is: Betaflight arms and a motor
   responds to a stick in Node. That needs only the 65 mm config path, the
   tick, RX and a plant at rest. The RPM model and current stand-in land
   right after it, in M4.

---

## 2026-10-22 | Phase 1 | stop point reached: Betaflight arms and a motor answers a stick, in Node

Branch `phase1/arm-and-motor`. No browser work yet. Stopped here as instructed.

### Build (M1)

- **Inputs:**
  - `vendor/betaflight` submodule at `77d01ba` (4.5.1), line endings checked, read-only
  - `patches/0001-keep-dyn-notch-in-simulator-build.patch`
  - `patches/0002-pg-sections-for-wasm-ld.patch`
- **What `scripts/build.sh` enforces:**
  - emcc 3.1.61 (`67fa4c1`) or refuse
  - no emcc environment overrides
  - vendor at the pinned commit and clean
  - patches applied to a copy with `--fuzz=0`; any offset or fuzz fails the build
  - relative paths, fixed `SOURCE_DATE_EPOCH`
  - `SC_LOOP_HZ` must be 1000..8000 and divide 1,000,000
  - `dist/` is replaced only when the hash matches the committed one, or with `SC_UPDATE_DIST=1`
- **Betaflight files: 102.** The 99 from the plan, plus:
  - `scheduler/scheduler.c` (needed `SCHEDULER_DELAY_LIMIT`)
  - `fc/tasks.c` (needed `TASK_GYROPID_DESIRED_PERIOD`)
  - `fc/dispatch.c`

  The first two need MCU-platform defines, which `target/QMSC/platform_mcu.h` supplies from `SC_LOOP_HZ`.
- **Output:** `dist/sim-core.wasm`, 155,555 B, sha256
  `39174b21622b3b2d9e07bfe936426d23d968095bbbcff82e6e930c78a471319e`.
  - Byte-identical across clean rebuilds.
  - **0 imports**, so no JS function, including `Math.*`, can reach the module.
  - 84 exports, pinned in `tests/node/abi-exports.json`.
- **`SC_LOOP_HZ=2000` build:** boots, passes the boot asserts, arms and drives
  the motors (8100 ticks of 500 us to arm-ready). It is not committed.

### Glue as built (differences from the plan)

**Symbols our glue provides (38).**
- clock: `micros`, `millis`, `delay`, `delayMicroseconds`
- system: `systemReset`, `systemResetToBootloader`, `failureMode`,
  `SystemCoreClock`, `getCycleCounter`, `clockMicrosToCycles`,
  `clockCyclesToMicros`, `stackHighMem`, `stackTotalSize`,
  `timerGetConfiguredByTag`
- gyro: `gyroSetSampleRate` (sets the acc rate too)
- motor and DShot: `motorPwmDevInit`, `dshotPwmDevInit`, `motors`,
  `useDshotTelemetry`, `dshotCommandWrite`,
  `dshotStreamingCommandsAreEnabled`, `dshotSetPidLoopTime`,
  `dshotDMAHandlerCycleCounters`
- ADC: `adcGetChannel`, `getVrefMv`, `adcDeviceByInstance`
- no TCP serial: `serTcpOpen`
- no MSP serial ports: `mspSerialProcess`, `mspFcProcessCommand`, `mspFcProcessReply`
- LED: `warningLedFlash`, `warningLedDisable`, `warningLedUpdate`
- IO: `IOInit`, `IOGetByTag`, `IOConfigGPIO`, `IOToggle`, `IOWrite`

**What compiling `scheduler.c`/`tasks.c` changed.** The plan's 12 scheduler
stubs and `taskUpdateRxMainInProgress` are gone. Betaflight's own task table,
`tasksInit` enables and rates, and RX state machine run.

**The tick.**
- Calls `schedulerExecuteTask` in the plan's order.
- Gates FILTER and PID with Betaflight's own `gyroFilterReady()` /
  `pidLoopReady()`.
- Runs `rxFrameCheck` and the failsafe check after the realtime tasks on
  every tick, as `scheduler()` does.
- Runs event tasks (RX) while their check function fires.
- Runs periodic tasks once at least one period has passed.

**Motor device.**
- Values are rounded to whole DShot units, as on the wire.
- Plant eRPM goes back as a GCR period in `decodeTelemetry`, which
  `motorWriteAll()` calls before each write, as on hardware.
- `dshotStreamingCommandsAreEnabled` uses Betaflight's own rule (3 s after
  motor enable). That needs a non-zero enable time, so **the sim clock starts at
  1.000 s** (`SC_BOOT_EPOCH_US`).

**Battery.**
- `DEFAULT_VOLTAGE_METER_SOURCE` and `DEFAULT_CURRENT_METER_SOURCE` are ADC.
- Plant voltage and current are converted into ADC counts by inverting
  Betaflight's own formulas.
- Betaflight reads 4.19 V for a 4.20 V pack (1 ADC LSB) and detects 1 cell.

**Boot.**
- Follows `fc/init.c` for the compiled subsystems, citing each block,
  including `debugMode` (init.c:406).
- Asserts, else a fault:
  - `pid_process_denom == 1`
  - `gyro.sampleRateHz == SC_LOOP_HZ`
  - `targetLooptime == tick`
  - acc rate
  - DShot protocol

**Input.**
- A 1024-sample ring of integer channels, stamped in whole microseconds of sim
  time, sampled and held onto the RX grid (250/500/1000 Hz only).
- During link loss the ring keeps draining and only transmission stops.
- The neutral pre-input frame is laid out through Betaflight's rcmap.

**Config: two instances.**
- The config instance enters the CLI. The flight instance never does, so
  arming is never blocked.
- A class diff starts from factory defaults.
- Per-line policy (`src/js/cli-policy.js`). Every line ends `applied`,
  `rejected` with a reason, `error` with Betaflight's message, or `comment`.
- `aux` lines are checked against Betaflight's own resolved echo. An unknown
  box id would silently become ARM, so its slot is cleared and the line rejected.
- `feature` lines outside AIRMODE/ANTI_GRAVITY/MOTOR_STOP/3D are rejected. A
  check instance boots the saved image and confirms the rest survived.
- Default aux lines go into free slots only.
- The 8-letter map is inverted fully.
- `save` happens once at the end, giving the EEPROM image the flight instance
  boots from.

**Class diffs.**
- Generated verbatim with quadmath's own `cliFor()` (`configs/*.diff`, source
  rev and card id in the header).
- They hold PIDs and rates only, and no `aux` lines, so the four default aux
  lines are always added for them.

**Plant.** `src/plant/rest_plant.c` is an M3 test plant: level on the floor at
+1 g, 1S at 4.20 V. M4 replaces it with the owner's RPM model.

### Results (`npm test`, all pass)

| Test | Result |
|---|---|
| abi-surface | 0 imports; exports match the allow-list; every Betaflight setting has an owning PG |
| arm-and-motor | Air65 diff: 19 applied, 0 errors, 4 default aux added. Arm-ready 5.100 s (boot grace 5 s). Armed on AUX1 in 50 ms. Idle DShot 158 = 48 + 5.5% x 1999 (default `dshot_idle_value`). 50% throttle: 1052 on all four. Full right roll: setpoint 740 deg/s (srate 74); left motors 2047, right 158 (saturated because the rest plant does not rotate). Disarm: 0. |
| config-policy | Unknown aux box rejected and slot cleared; TELEMETRY/OSD/LED_STRIP/ESC_SENSOR rejected; AIRMODE applied and confirmed after save; `map TAER1234` boots, arms and drives the motors; a 6 s link loss puts Betaflight in failsafe (phase 4, disarmed) without stalling input, and the link recovers; fractional time, fractional aux and NaN input refused |
| determinism-repeat | Two fresh instances, one 3 s sim-time input stream (arm, throttle steps, roll sweep, yaw reversals): the whole 512-byte state block is identical on every tick |

### Adversarial code review before stopping (2 reviewers, 21 findings, all verified)

**Fixed:**
- aux unknown-id trap
- silent feature clearing
- ungated FILTER/PID and missing boot asserts
- input ring stall during link loss
- rcmap: AETR only, 4 letters
- neutral frame ignored the map
- out-of-bounds CLI line at the ABI (now at most 255)
- fractional time stamps, non-integer aux, any RX rate
- `debugMode` never set
- DShot streaming stub was `true`
- motor values unrounded
- configure stacking on the previous class
- partial determinism hash
- `SC_LOOP_HZ` octal/upper bound
- patch fuzz
- no hash enforcement in `build.sh`
- unpinned ABI surface: an allow-list test instead of an explicit linker export list

**Still open:**
- The complete HARDWARE_VALUE key list is not yet generated from
  `cli/settings.c` (TODO in `cli-policy.js`, M2).
- B1 (byte-exact) is enforced by `build.sh` but is not part of `npm test`,
  which has no emcc.

### What went wrong

- PowerShell mangled the pipes in a quoted `wsl -e bash -c` command. All WSL
  runs now go through a script file.
- Windows has no Python; text patching went through Node.
- `drivers/pwm_output_dshot_shared.h` needs DMA types. Replaced by a
  layout-identical local struct for the CLI's counters.
- Our static `rxFrameTimeUs` clashed with a Betaflight declaration. Renamed.
- The first aux verification matched the CLI's echo of the typed line, not
  Betaflight's resolved line. The test caught it; the check now uses the last
  echo.
- The first draft gated FILTER/PID as "always", a reimplementation the
  reviewer caught. It now calls Betaflight's predicates.

### Next (waiting for the owner's go)

1. **M4 plant:**
   - the owner's RPM model: KV x effective voltage, first-order lag, prop drag torque load
   - thrust and rigid body ported from `quadphysics.js`
   - contact and battery
   - the bench mAh/min current stand-in
   - this enables F6 axis signs, P1-P5 and D4
2. **M2 remainder:** HARDWARE_VALUE list generation, C1 runtime-effect tests.
3. **Then browser work:** D2 Node vs Chrome, the 4 ms gamepad poll, the
   black-box X tests.
4. **75 mm** still waits on a bench decision (2026-10-22 decisions, finding 3).

---

## 2026-10-22 | Phase 1 | the owner's test list green on the rest plant; sim-core.js per the ABI spec

Branch `phase1/arm-and-motor`. The owner accepted the gate (`npm run gate`) and
set this stop:
- Node vs Chrome hash, and frame independence at 30/60/144/240.
- Reset vs fresh load.
- Diff passthrough: two diffs differing only in rates, with max roll rates
  differing by the diff ratio within 2 %.
- Config count check.
- Black box vs WebFPV on identical input, with a tolerance we set.
- A browser harness page in `tests/`, headless Chrome, zero console errors.
- `sim-core.js` finished per the ABI spec, and `npm test` running everything
  in one command.
- No quadmath wiring (Phase 2).

**Scope call: the M4 plant was not started.** The owner has not said go on
M4, and none of the tests listed for this stop needs a plant that moves.
Everything below runs on the M3 rest plant: a quad level on the floor at
+1 g, 1S, motors captured but not moving it. What that leaves untested is
under "What the rest plant cannot show".

### Why throttle 1500 gives rcCommand[THROTTLE] 1473 (owner's question on the gate)

It is Betaflight's own throttle scaling, with two settings at their defaults
(the class diffs set neither):

1. **`min_check` = 1050** (`rxConfig()->mincheck`; default at `pg/rx.c:91`;
   CLI key at `cli/settings.c:746`). `updateRcCommands` (`fc/rc.c:717-718`)
   maps `min_check..2000` onto `0..1000` in integer arithmetic:
   `(1500 - 1050) * 1000 / (2000 - 1050) = 450000 / 950 = 473` (473.68,
   truncated).
2. **`thr_mid` = 50, `thr_expo` = 0** (`fc/controlrate_profile.c:46-47`).
   `initRcProcessing` (`fc/rc.c:781-786`) builds the 12-point throttle curve
   from them. With expo 0 the curve is a straight line,
   `lookup[i] = 1000 + 100 i`. `rcLookupThrottle(473)` (`fc/rc.c:154-158`)
   gives `lookup[4] + 73 * (lookup[5] - lookup[4]) / 100 = 1400 + 73 = 1473`.

So channel values 1000-1050 all mean zero throttle, and the remaining
1050-2000 is stretched over the full range: mid stick is 47.3 %, not 50 %.
A real quad with these settings behaves the same. The class configs planned
for Phase 2 add `thr_mid 62`, which will bend this curve.

### What was built

**C ABI (version 1), named as in the plan's table.**

- **Exports renamed to the plan:**
  - `sc_cli_enter`, `sc_cli_line(ptr, len)`, `sc_cli_log_ptr`/`_len`/`_clear`
  - `sc_reboot_requested`, `sc_set_rx_rate`, `sc_rx_link`, `sc_fault`
  - `sc_state_ptr`, `sc_fc_ptr`, `sc_events_ptr`/`_len`/`_clear`
  - `sc_battery_carry`

  Internal names that collided were renamed: `sc_fault_state`,
  `sc_reboot_flag`, `sc_rx_link_set`, `sc_cli_port_enter`.
- **State block v1, 45 doubles.** In order:
  - `t_us`, pos, vel, quat, omega, specific force
  - motorDshot, motorOut, motorDir, rpm, thrustN
  - vbatLoaded, amps, mah, soc
  - groundClearance, airborne, contactFlags, fault

  The plant owns `sc_plant` (`src/sc.h`). The rest plant fills what a quad
  at rest has.
- **Betaflight readouts v1, 51 doubles.**
  - The plan's list: armed, armingDisableFlags, flightModeFlags, failsafe
    phase, vbat, amps, mAh drawn, cells, setpoint, gyroFiltered, pidSum,
    rcCommand, motor, debug[8], debugMode.
  - Then what the OSD and the tests read: motorsEnabled, rcData[8],
    rxSignal, attitude, airmode, crash flip, 3D, and the RPM filter
    (`isRpmFilterEnabled()`).
  - The plan listed AIRMODE, FLIP_OVER_AFTER_CRASH and 3D under
    flightModeFlags. Betaflight's flightModeFlags has none of them, so each
    is a separate field read from Betaflight's own getter.
- **Trace hash in C.**
  - SHA-256 (`src/glue/sha256.c`, FIPS 180-4, integer only).
  - Covers both blocks at the end of every tick from boot.
  - On by default. It costs about 2.8 µs per tick, against 0.6 µs without.
  - `sc_trace_digest` is NULL until `sc_trace_start`, so an untraced run
    never yields a hash.
- **Event queue.** 1024 events, with a dropped count. It carries faults now:
  every fault goes through `sc_set_fault`, and the first one wins. Contacts
  and triggers come with M4.
- **Battery carry:** `sc_battery_carry(soc, filtered V)`.
  - Allowed only after `sc_boot` and before the first tick.
  - `sc_battery_state` reads the same two values back.
  - The rest plant rests at the carried voltage.
- **CLI error detection.**
  - `sc_cli_line` skips the CLI's echo of the typed line.
  - Only a `###ERROR` that starts a line of Betaflight's output counts.
- **Neutral boot frame** (`neutralFrame`, `src/glue/tick.c`). It follows
  Betaflight's own throttle check (`fc/rc_controls.c`
  `calculateThrottleStatus`):
  - Sticks sit on `mid_rc`.
  - Throttle is below `min_check`, or on `mid_rc` for 3D unless
    3D-switched mode or the 3D box is on.
  - Aux is low.
  - Low values stay at or above `rx_min_usec`.
  - `sc_neutral_valid` says whether the frame's flight channels are valid
    pulses by Betaflight's rule (`rx/rx.c` `isPulseValid`, which is static
    there).
  - The first version of this put a literal 1500 on the 3D throttle. It
    broke `3d_switched_mode` and a moved `mid_rc` (review, below).
- **Deviations from the plan's ABI table:**
  - `sc_input(ch16, tUs)` takes an explicit sim-time stamp, so replays are
    exact. The JS default is the next tick, as in the plan.
  - Extras: `sc_loop_hz`, `sc_scratch_ptr`/`_size`, `sc_time`,
    `sc_pg_missing`, `sc_state_len`, `sc_fc_len`, `sc_events_dropped`,
    `sc_trace_start`, `sc_trace_digest`, `sc_battery_state`, `sc_neutral_valid`.
- **Waiting for M4, and absent from the module** (`abi-surface` asserts
  they are absent): `sc_plant_set`, `sc_world_clear`/`floor`/`box`/`trigger`,
  `sc_pose`.
- **`dist/sim-core.wasm`:** 159,153 B, sha256
  `bd3abde4c92dabc1959e5fdcaed56d7d007d16b59ffe9cc9299df16004c33d1f`, 0 imports,
  96 exports
  (`tests/node/abi-exports.json`).

**`sim-core.js`, per the plan's API.**

| API | As built |
|---|---|
| `load` | `SimCore.load(url \| bytes \| Module, { rxHz, trace })` |
| `configure` | `configure({ diff })` (or a string): the line report, `save`, and a fresh flight instance booted to arm-ready (`report.boot`) |
| `edit(lines)` | Disarmed only. Applies on top of the saved image and reinits with the battery carried. |
| `reinit({ freshPack, battery })` | New instance. Carries the EEPROM image, the channel map, and the battery (state of charge and filtered voltage) unless `freshPack`. `battery: { soc, vbatFiltered }` lets a fresh load continue a session. Boots to arm-ready within the 35 s cap; on a miss it throws `err.code = 'boot-timeout'`. |
| `input(channels, tUs?)` | Integer channels 1000..2000 in function order (AETR, AUX1..AUX12), laid out through the inverse rcmap. Stamps are whole microseconds and never go backwards. |
| `link(up)` | As planned. |
| `advance(frameDtMs)` | Accumulator to whole ticks, at most 250 per call; the excess is a pause and is dropped (`pausedUs`). Returns the ticks run. |
| `step(n)` | Extra: exact ticks for scripts and tests. |
| `state`, `fc` | Getters. `fc.mode` holds angle, horizon, failsafe, airmode, crashFlip and mode3d. `battery` is a getter too. |
| `alpha`, `lerpState(alpha)` | Render interpolation between the last two ticks; the quaternion is nlerped. Render only. |
| `events()` | Drains the event queue. |
| `traceHash()` | As planned. |
| `get(key \| keys, { profile, rateprofile })` | Betaflight's `get` on a config instance of the saved image. A profile Betaflight does not have throws instead of reading another one. |
| `diff(form = 'all')` | Betaflight's `diff all` on a config instance of the saved image. |
| `rateCurve(axis, n)` | Probe instance: the saved image with `rc_smoothing OFF`, one RX frame per stick position, setpoint read from Betaflight. No rate formula in JS. |
| `fault`, `simTimeUs`, `loopHz`, `tickUs` | Getters. |
| `compat` | The read-only adapter. `twr` and `floatiness` need plant parameters and say so. |
| `sticksToChannels()` | Extra helper for scripts. |
| `teleport()`, `configure({ plant, world, battery })` | Throw "arrives with the M4 plant". |

**Boot and switches.**
- Boot waits until no arming-disable flag is left except those that only
  say where a switch is:
  - `NOPREARM`, for a PREARM range
  - `ARM_SWITCH` with `NOT_DISARMED`, for an ARM range that covers aux low
  - `BOXFAILSAFE` with `RX_FAILSAFE`, for a failsafe range that covers aux
    low, but only while the boot frame's sticks are valid pulses, so the box
    is the sole cause

  Each comes from Betaflight's own rules (`fc/core.c`, `rx/rx.c`,
  `flight/failsafe.c`).
- `reinit()` returns those flags as `switchFlags`. The host moves the switch,
  and Betaflight arms (tested for all three).
- This departs from the plan's "boot until `getArmingDisableFlags() == 0`".
  That rule could never finish for these configs, while real Betaflight boots
  them and waits for the pilot.

**`configure()` and `edit()` are atomic.**
- The new image replaces the old one only once it has booted.
- On failure the previous config, channel map and flight instance stay, and
  the error carries the line report (`err.report`).

### Config policy changes this stop

Every one of these was found by a test or a review. Each has a test.

- **`set` echo check.** `cli/cli.c` `cliSet` parses numbers with
  `atoi`/`strtol` and checks only the range:
  - `set p_yaw =` stored 0 with no error.
  - `set i_yaw = 12abc` stored 12 with no error.

  sim-core now reads Betaflight's echo (`<name> set to <value>`). If what
  Betaflight stored is not what the line asked for, it puts the old value
  back and rejects the line with both values. The comparison:
  - numbers as numbers (`0550` is 550)
  - lookup names without case
  - arrays element by element
  - `-` as the empty string
- **Boot check of every `set`.** After `save`, the saved image boots on a
  check instance. Each line's value is read back in the setting's own scope,
  taken from Betaflight's `get` (master, `profile N` or `rateprofile N`).
  - Betaflight's boot-time `validateAndFixConfig` / `validateAndFixGyroConfig`
    can change a value the CLI accepted. Example: `gyro_notch1_hz 100` with
    `gyro_notch1_cutoff 150` is zeroed. Such a line is now rejected with the
    value Betaflight kept.
  - A line overridden later in the same scope stays applied, marked
    "superseded by line N".
  - Features are checked the same way: the last line per feature.
- **Comments are cut as Betaflight cuts them**, at the first `#`, with
  trailing spaces dropped (`cli/cli.c` `processCharacter`).
  - sim-core sends and checks only that part.
  - In the comment, only a control character is rejected (DEL edits the
    line, CR ends it). That holds for a line that starts with `#` too, so a
    diff saved with CR-only line endings is rejected, not read as one comment.
- **`set` without `=`** is rejected: it only prints. `set` with `=` and a
  name that is not a setting goes to Betaflight, which reports INVALID NAME.
- **`aux` lines** are checked against Betaflight's resolved slot on all of
  box, channel, logic and linked box. An unknown logic or linked box is
  rejected and the slot cleared, as an unknown box id already was.
- **`get()`** reads names in any case, as Betaflight's `get` does.

### Results (`npm test`, all pass)

| Test | What it shows |
|---|---|
| B1 B2 (`gate-arm-motor --build`) | Two clean builds are byte-identical and equal the committed hash; `vendor/betaflight` untouched. Run on the committed tree; the summary of the full `npm test` run is in the next entry. |
| B3 B4 B5 `abi-surface` | 0 imports; 96 exports match the allow-list; the 21 plan exports that do not wait for M4 are present and the 6 M4 ones absent; 0 settings without a PG; boot asserts hold |
| F5 `arm-and-motor` | Arm-ready at 5.100 s; arms on AUX1; idle DShot 158; 50 % throttle gives 1052; full right roll gives setpoint 740 deg/s with the left motors at 2047; disarm gives 0 |
| C2 F5 `config-policy` | See the list after the table. |
| C1 C2 C3 `config-count` | See the list after the table. |
| C1 `diff-passthrough` | See the list after the table. |
| D1 `determinism-repeat` | 16 scenarios (2 class presets × acro/angle × RPM filter off/on × 3D off/on), each identical twice. All arm and run motors; angle and 3D are as scripted. 16 distinct traces. |
| D3 `frame-independence` | See the list after the table. |
| D4 `reset-vs-fresh` | See the list after the table. |
| X1 `blackbox-webfpv` | See the list after the table. |
| D2 `node-vs-chrome` | The same 16 scenarios in Node 24.21.0 and headless Chrome 155.0.8059.85: 16 of 16 identical. Chrome with `advance()` at a jittered 144 Hz also matched Node. **0 console messages** from the harness. The capture is proven by an injected `console.error` it must catch. A harness that fails to load reports it at once. |

**`config-policy`** covers:
- an unknown aux box: rejected and cleared
- peripheral features: rejected
- `map TAER1234`: flies
- a 6 s link loss: failsafe phase 4, then recovery
- bad input: refused
- 3D, 3D with `3d_switched_mode`, 3D with `mid_rc 1560`, and `mid_rc 1560`
  alone: each boots and arms
- `rx_min_usec 1010`: boots with the neutral frame inside the pulse window
- PREARM, ARM on aux low, and FAILSAFE on aux low: each boots with only its
  switch flags, then arms once the switch moves
- a config that can never reach arm-ready, through `configure()` and
  `edit()` (`rx_min_usec` above `min_check`; `rx_max_usec` below the centred
  sticks, with and without a failsafe switch on aux low): throws
  `boot-timeout` with the report attached, and the previous config and
  channel map keep flying
- comments handled as Betaflight handles them, CR and DEL included
- raw ABI: CLI error scan, carry precondition, no digest without a trace

**`config-count`** covers 9 diffs: both class diffs, WebFPV's six at
`518846c`, and a 51-line synthetic C2 set.
- Every line has the verdict the policy requires, pinned line by line, so
  lines = applied + rejected + errors + comments cannot hide a wrongly
  rejected tune line.
- Every applied `set` still in force reads back in its own scope: 19/19,
  19/19, 95/95, 58/58, 58/58, 58/58, 32/32, 32/32 and 9/9.
- Superseded lines are pinned.
- The rejected `set p_yaw =` and `set i_yaw = 12abc` left the defaults in
  place.

**`diff-passthrough`** covers two pairs that differ only in rate lines:
- WebFPV's check-12 fixtures (srate 67 vs 84): max roll rate ratio 1.25373
  against a diff ratio of 1.25373.
- The 65 mm diff with its roll rates changed (srate 74 vs 92): 1.24324
  against 1.24324.
- Both directions and the probe agree: **0.000 %** against the 2 % limit.
- `dshot_bidir ON` turns the RPM filter on, and OFF leaves it off.
- `p_roll` 54 to 81 raises pidSum from 60.72 to 76.49 at the same setpoint.

**`frame-independence`** runs two scenarios (angle with the RPM filter; 3D).
- Cadences: exact ticks, plus `advance()` at 30, 60, 144 and 240 Hz, fixed
  and with seeded ±50 % jitter. That is 9 cadences, giving **1 hash** per
  scenario.
- Every `advance()` call is checked against the frame time it was given, so
  an `advance()` that ignores or halves frame time fails. Both mutants were
  tried and caught.
- Frame counts match each cadence.

**`reset-vs-fresh`** runs 4 scenarios (both presets, acro and angle).
- Flight A starts from a part-drained pack (0.6 / 3.85 V; Betaflight reads
  3.84 V) and runs on the frame path.
- `reinit()` drops the frame accumulator and carries the pack.
- Flight B equals a fresh load given the same carry: **0 mismatching
  ticks** of 2000, and the same trace from boot.
- The same fresh load with a full pack differs on every tick, so the carry
  is visible to Betaflight.

**`blackbox-webfpv` (X1).** The tolerance is **exact**: 0 ulp on setpoints,
string-equal readback.
- **F1 rate curve:** 5 rate types × 3 axes × 1001 quanta, RC smoothing off,
  0 mismatching ticks.
- **F2 setpoint trajectory:** smoothing on, steps, a ramp and reversals, all
  5 rate types. 23,380 ticks × 3 axes, 0 mismatching after the 1-tick RC
  shift. Without the shift about 1,110 ticks per axis differ, so the shift
  is real.
- **F4 readback:** 176 of 176 WebFPV keys that Betaflight also has are
  string-equal.

**Where WebFPV is not Betaflight (F4).** The test asserts Betaflight's
behaviour in each case:
- **`launch_angle_limit`:** WebFPV defaults to 40; Betaflight's default is 0
  (`flight/pid.c:181`).
- **`rpm_filter_weights`:** WebFPV splits it into `_1`/`_2`/`_3`; Betaflight
  has one array.
- **`set p_roll = 251`:** WebFPV stores 251; Betaflight refuses it
  (INVALID VALUE).
- **`set roll_srate = 300`:** WebFPV clamps it to 255; Betaflight refuses it.
- **`set p_roll = -5`:** WebFPV clamps it to 0; Betaflight refuses it.
- **`profile 1`:** WebFPV has one profile; Betaflight scopes the profile.
- **Lowercase `set rates_type = kiss`:** WebFPV's `sim_init` fails (`-4`);
  Betaflight accepts any case.

These are the plan's list plus the lowercase case. All the WebFPV fixtures
also carry `battery_capacity`, which is not a Betaflight 4.5.1 key
(Betaflight's is `bat_capacity`), so Betaflight refuses it.

**Tolerances set for this stop.** None was changed after a run.
- X1: exact.
- C1: 2 %, the owner's figure.
- D1-D4: identical hashes.
- Console: zero errors.

### What the rest plant cannot show (flagged)

- **RPM filter on vs off.**
  - The two traces differ only in Betaflight's filter-enabled flag. Gyro
    and eRPM are zero, so the filter has nothing to filter.
  - The first D1 run had them identical. The readout was added so the trace
    proves the switch reached the flight instance.
  - The filtering itself is M4.
- **D4 in the air.** Ground only.
- **Battery drain.** The carry is real and tested, but the rest plant never
  drains during flight A.
- **"Max roll rate" in C1 is Betaflight's commanded setpoint.** The achieved
  rate (F3, X2) needs a plant that rotates. WebFPV's own check 12 measured
  the achieved rate (0.65 % off); ours is exact because nothing physical is
  in the loop yet.
- **Waiting for M4:**
  - X2 and X3
  - F3, F6, F8 sag compensation, F9 reverse thrust
  - P1-P5
  - D5 non-finite plant fault
  - C1's `yaw_motors_reversed` and in-flight `adjrange`

### Phase 1 test list status

- **Green:** B2-B4, C2, C3, D1-D4, F1, F2, F4, F5.
- **Green, needs WSL emsdk:** B1.
- **Partial:**
  - B5: our boot asserts; the plan's ATTITUDE-period and acc-LPF asserts are
    not added yet.
  - C1: rates, the RPM filter and P are done; yaw reversal and adjrange wait
    for M4.
  - C4: every corpus diff with rejected lines still saved.
  - F7: the RPM-filter flag follows bidir; the dyn notch note is logged.
  - F8: vbat within 1 LSB and the cell count are right; sag compensation
    needs M4.
- **Waiting for M4:** F3, F6, F9, P1-P5, X2, X3, and the respawn part of C5.

### Review before stopping (ultracode: four adversarial rounds)

Ultracode was on, so the change went through adversarial review workflows
until the findings ran out of substance. Each finding was confirmed by a
separate skeptic agent before it counted.

1. **Round 1** (4 lenses: C, JS API, test validity, browser and rules; one
   skeptic per lens): 25 confirmed, 1 refuted. Most important:
   - D4 never exercised the battery carry: the fresh side got no carry, and
     the rest-plant pack could not differ.
   - 3D boot broke on `3d_switched_mode` and a moved `mid_rc`.
   - Betaflight's boot-time validation could change `set` values reported
     as applied.
   - Clearing a string with `-` was rejected.
   - Feature lines overridden later in the diff were mislabelled.
   - D3 could not catch an `advance()` that miscounts frame time.
   - The CDP client could hang `npm test`.
   - Plus smaller ones.
2. **Round 2** (one agent per fix group, plus a fresh reviewer): 23 of 25
   fixes confirmed complete, 2 incomplete, and 6 new findings. The main new
   one: a config whose arming waits on a switch never booted, and
   `configure()`/`edit()` then lost the line report and left a bad config.
3. **Round 3** (narrow, on the round-2 code): 5 confirmed. My first
   switch-flag rule worked only for PREARM: Betaflight pairs the ARM and
   FAILSAFE flags with a second flag. The comment checks also ran on the
   whole line.
4. **Round 4** (narrow, on the round-3 code): 3 confirmed, all low, each
   needing an unusual combination of settings:
   - a failsafe switch could mask an RX_FAILSAFE caused by invalid sticks
   - a line starting with `#` could carry a CR
   - two mutants survived

Every confirmed finding is fixed and has a test. Where a reviewer showed a
mutant surviving, the new test kills it. I stopped after round 4 because its
findings were all low.

### What went wrong

- **Power cut mid-rebuild.** The session died while rebuilding the module
  for the RPM-filter readout. Afterwards the tree was intact and `dist/` was
  still at the previous build. I rebuilt and reran everything; nothing was
  lost.
- **Text patches through a shell heredoc broke three times.** `\n` and `\d`
  inside JS and C strings became real newlines and bare letters. In one case
  the patch only half-applied, silently. `node --check`, a test and a grep
  caught each one, and all were redone with exact edits. Rule kept from here
  on: no heredoc patches of escaped text.
- **The first C1 run stopped on WebFPV's own fixture.** Betaflight refuses
  `battery_capacity`. The test now requires every rate line to apply and
  reports the refused non-rate lines.
- **The first D1 run had the RPM on/off traces identical** (see above). The
  fix was a readout, not a looser assertion.
- **My first switch-flag rule could not work for two of its three cases.**
  Betaflight pairs ARM and FAILSAFE switch flags with a second flag. Round 3
  of the review found it; the rule now follows Betaflight's pairs, and each
  case has a test.

### Next (waiting for the owner's go)

1. **M4 plant:**
   - the owner's RPM model, thrust, rigid body and contact from
     `quadphysics.js`
   - battery and the bench current stand-in
   - the plant parameter block and world exports
   - this unblocks X2/X3, F3, F6, F8, F9, P1-P5 and air D4
2. **M2 remainder:** the HARDWARE_VALUE list, and the B5 ATTITUDE and
   acc-LPF asserts.
3. **75 mm** still waits on a bench decision.

---

## 2026-10-22 | Phase 1 | full `npm test` on the committed tree (`e5179b3`)

`npm test` (`node tests/run-all.mjs`), Windows, Node 24.21.0, emsdk 3.1.61 in
WSL, Chrome 155.0.8059.85. Exit 0.

- `git diff --stat vendor/betaflight` and `git -C vendor/betaflight status --porcelain`: both empty.
- Build 1 and build 2: `dist/sim-core.wasm` 159,153 B, sha256
  `bd3abde4c92dabc1959e5fdcaed56d7d007d16b59ffe9cc9299df16004c33d1f` both
  times, equal to the committed `dist/sim-core.wasm.sha256`.

```
PASS   134.4 s  B1 B2 byte-exact build, vendor untouched; F5 arm, motors
PASS     0.1 s  B3 B4 B5 ABI surface, PG coverage, boot asserts
PASS     0.1 s  F5 arm and motor answer the sticks
PASS     0.9 s  C2 F5 config policy, map, link loss, bad input
PASS     0.6 s  C1 C2 C3 config count and readback
PASS     0.3 s  C1 diff passthrough (rates ratio, RPM filter, P)
PASS     1.0 s  D1 determinism repeat
PASS     0.6 s  D3 frame independence 30/60/144/240 Hz
PASS     0.6 s  D4 reset vs fresh load
PASS     1.1 s  X1 black box vs WebFPV (F1 F2 F4)
PASS    11.9 s  D2 Node vs headless Chrome, console clean
all 11 passed
```

Stopped here for the owner. The PR to `main` is open; the M4 plant waits for go.
