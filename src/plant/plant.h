/*
 * The plant: what the quad's body, motors, pack and world do with the motor
 * values Betaflight sends. Three models, chosen by the plant block:
 *
 *   SC_MODEL_REST      a quad at rest on the floor that never moves (M3); the
 *                      default until a plant block arrives
 *   SC_MODEL_PHYSICAL  the M4 plant: RPM from KV x effective voltage with a
 *                      first-order motor lag loaded by prop drag torque,
 *                      thrust and torque from RPM squared plus each rotor's
 *                      reaction torque J dw/dt, a 1S pack with cell IR,
 *                      quadratic drag (frontal and plan) and rotational
 *                      damping, quadmath's rigid body and ground effect, and
 *                      contact through a five-point footprint (four duct rims
 *                      and the canopy top)
 *   SC_MODEL_PARITY    quadmath's own motor spool, aero and battery, for the
 *                      port-parity tests P2 and P3 only
 *
 * Plant block v1: doubles, index = meaning (ABI sc_plant_set). sim-core.js writes
 * it from an airframe file (airframes/<id>.json). Frozen: abi-surface checks
 * this enum against sim-core.js's field order.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define SC_MODEL_REST 0
#define SC_MODEL_PHYSICAL 1
#define SC_MODEL_PARITY 2

enum {
    PB_MODEL = 0,
    // Body
    PB_MASS = 1,                // kg
    PB_WHEELBASE = 2,           // m, motor-to-motor diagonal
    PB_BOX_HEIGHT_RATIO = 3,    // inertia box height / wheelbase
    PB_PROP_DIAMETER = 4,       // m
    // Motor and prop
    PB_KV = 5,                  // rpm per volt
    PB_V_REF_CELL = 6,          // V per cell at which PB_TMAX holds
    PB_LOAD_FRACTION = 7,       // loaded rpm / (KV x V) at full throttle
    PB_TMAX = 8,                // N per motor at full throttle and PB_V_REF_CELL
    PB_KQ_RATIO = 9,            // yaw torque = kQ x thrust x wheelbase / 2
    PB_TAU = 10,                // s, motor lag (physical: linearised at hover; parity: spool up)
    PB_TAU_DOWN_MULT = 11,      // parity only: spool-down tau / spool-up tau
    PB_REVERSE_SCALE = 12,      // reverse thrust / forward thrust at equal speed
    // Aero
    PB_CDA_FRONT = 13,          // m^2, body X and Y (prop plane)
    PB_CDA_PLAN = 14,           // m^2, body Z (thrust axis)
    PB_SKIN_B = 15,             // N s/m, linear body drag
    PB_AERO_B = 16,             // N m s/rad, rotational damping
    PB_AERO_C = 17,             // N m s^2/rad^2
    PB_DISC_K = 18,             // extra quadratic Cd at zero thrust
    PB_DISC_END = 19,           // |motor output| where the extra is gone
    PB_GROUND_K = 20,           // ground-effect bonus at zero clearance
    // Environment
    PB_GRAVITY = 21,            // m/s^2
    PB_AIR_DENSITY = 22,        // kg/m^3
    // Pack
    PB_CELLS = 23,
    PB_CAPACITY_MAH = 24,
    PB_CELL_IR = 25,            // ohm per cell
    PB_I_HOVER = 26,            // A, motor current at hover (rotors at PB_RPM_HOVER), less PB_I_QUIESCENT
    PB_OCV = 27,                // 7 values: V per cell at SoC 0, .05, .15, .40, .70, .90, 1
    // Parity battery (quadmath sim-whoop.js stepBattery)
    PB_SAG_DROP = 34,           // V at full load
    PB_HOVER_SECONDS = 35,
    PB_SAG_SCALE = 36,
    // Contact (quadmath sim.html onSubstep and sim-whoop.js resolveDuctHit)
    PB_BOUNCE_SCALE = 37,
    PB_CRASH_SCALE = 38,
    PB_SPIN_SCALE = 39,
    // Footprint (physical model): four points on the duct rims at the arm
    // angles and one on the canopy top
    PB_DUCT_RADIUS = 40,        // m, duct outer radius
    PB_HULL_BELOW = 41,         // m, duct bottom below the CG (the rest height)
    PB_HULL_ABOVE = 42,         // m, canopy top above the CG
    // Pack current: PB_I_QUIESCENT, always, plus PB_I_HOVER x (rpm /
    // PB_RPM_HOVER)^PB_CURRENT_EXP summed over the rotors the ESCs drive (each
    // draws a quarter of PB_I_HOVER at PB_RPM_HOVER; a rotor at duty 0 brakes
    // on its shorted winding and draws nothing)
    PB_RPM_HOVER = 43,          // rpm at hover
    PB_CURRENT_EXP = 44,        // exponent of the motor current against rpm
    PB_I_QUIESCENT = 45,        // A, the pack current with every motor at duty 0
    // The actuator between Betaflight's motor outputs and the rotor model
    // (physical model): the duty arrives PB_MOTOR_DELAY late (whole ticks:
    // the DShot frame and the ESC's update), then follows a first-order lag
    // of PB_ELEC_TAU (the winding's L/R) before the rotor's mechanical lag.
    // 0 is off for either, and leaves the plant as it was bit for bit.
    PB_MOTOR_DELAY = 46,        // s, at most SC_DELAY_TICKS_MAX ticks
    PB_ELEC_TAU = 47,           // s
    PB_LEN = 48,
};

// Derived constants, computed from the block when it is set (readout only).
enum {
    PD_KV_RAD = 0,              // rad/s per volt
    PD_KT_MOTOR = 1,            // N m per amp (1 / PD_KV_RAD)
    PD_OMEGA_FULL = 2,          // rad/s at full throttle and reference voltage
    PD_KT_PROP = 3,             // N per (rad/s)^2
    PD_KQ_PROP = 4,             // N m per (rad/s)^2
    PD_R_WINDING = 5,           // ohm
    PD_J_ROTOR = 6,             // kg m^2
    PD_OMEGA_HOVER = 7,         // rad/s
    PD_DUTY_HOVER = 8,          // at the reference voltage, no sag
    PD_IXX = 9,
    PD_IYY = 10,
    PD_IZZ = 11,
    PD_ARM = 12,                // m, motor offset per axis
    PD_AMPS_FULL = 13,          // A, the current model at full throttle and the
                                // reference voltage (readout)
    PD_LEN = 14,
};

int sc_plant_configure(const double *block, int count);
const double *sc_plant_derived(void);
int sc_plant_model(void);
// Betaflight-side settings the plant follows, read at boot.
void sc_plant_follow_betaflight(bool mode3d, bool propsOut);
// Bench override for plant tests: motor (or -1, all) runs at duty -1..1; a
// duty outside that range clears it.
void sc_plant_override(int motor, double duty);
// A pose event at the next tick boundary.
void sc_plant_pose(const double pos[3], const double quat[4], const double vel[3]);
// The world floor moved or the world was cleared: the rest plant stays resting
// on the floor, and the contact edge state follows the quad's position.
void sc_plant_floor_moved(void);
// World (world.c). Boxes and triggers are module-frame micrometres:
// x0 y0 z0 x1 y1 z1.
void sc_world_reset(void);
double sc_world_floor_z(void);
void sc_world_set_floor(int32_t zUm);
int sc_world_add_box(const int32_t um[6], int kind, int id);
int sc_world_add_trigger(const int32_t um[6], int id);
// Ground clearance at a module-frame point (m), as quadmath's hook computes it.
double sc_world_clearance_at(const double pos[3]);
// After a pose: contact and trigger edge state for the new position.
void sc_world_pose_sync(const double pos[3]);
// After the floor moved: floor and trigger edge state only.
void sc_world_edge_sync(const double pos[3]);
// Contact after integration; returns flags (1 floor, 2 box) and queues events.
uint32_t sc_world_contact(double pos[3], double vel[3], double omega[3], double dt, double bounceScale,
                          double crashScale, double spinScale);
// One footprint point (module frame, m and m/s; startPos where the point was
// at the start of the tick): floor and boxes, no floor pad, no spin kick.
// Corrects pos and vel in place; returns flags (1 floor, 2 box).
uint32_t sc_world_point(double pos[3], double vel[3], const double startPos[3], double dt, double bounceScale,
                        double crashScale, double spinScale, bool *floorHit, bool *scrub);
// Whether a module-frame point is strictly inside a box.
bool sc_world_inside(const double pos[3]);
// After the footprint points: floor touch and leave events, and triggers at the CG.
void sc_world_after_points(const double com[3], bool floorHit);
// The CG's height above the floor when resting on it (edge state after a
// pose or a floor move).
void sc_world_set_rest_height(double metres);
// The footprint's hull clearance (physical model): the CG's height above the
// floor or the box top underneath, less hullBelow.
double sc_world_hull_clearance(const double pos[3], double hullBelow);
