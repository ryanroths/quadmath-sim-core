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
 *                      and the canopy top), plus the ducts' sides (a tube
 *                      round each motor) against walls, which answer with a
 *                      restitution and Coulomb friction
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
    // Over-discharge (physical model): the pack past its capacity. SoC goes
    // below 0 (each 0.01 is 1% of PB_CAPACITY_MAH drawn beyond it) down to
    // SC_SOC_FLOOR, and the OCV falls from PB_OCV's SoC 0 value through
    // these three, linear between them
    PB_OCV_OVER = 48,           // 3 values: V per cell at SoC -0.05, -0.10, -0.15
    // Walls (physical model): each duct is a tube, PB_DUCT_RADIUS round, from
    // PB_HULL_BELOW under the CG up PB_DUCT_HEIGHT, and a box's vertical face
    // answers its sides, the duct rims and the canopy with a restitution and
    // Coulomb friction; the floor, box tops and undersides are as before
    PB_DUCT_HEIGHT = 51,        // m, duct bottom to duct top; 0: no sides, the footprint alone
    PB_WALL_FRICTION = 52,      // friction impulse / normal impulse, at most
    PB_WALL_RESTITUTION = 53,   // speed out / speed in, along the face normal
    PB_LEN = 54,
};

// The lowest state of charge a physical pack reaches (the last
// PB_OCV_OVER point), and the lowest a battery carry accepts.
#define SC_SOC_FLOOR (-0.15)

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
// faceMask: SC_WORLD_ALL_FACES (a footprint point: every face and the
// floor), or a duct's side point's face kinds (sc_world_face_bit of their
// outward normals, box vertical faces), met among the boxes sc_world_near
// found this tick, only through the box's surface of least penetration, no
// deeper than the point came into the box this tick and the side reach, and
// out by what came in this tick and 1 mm of what was there before (an older
// overlap creeps out), no floor. wallRest
// at or above 0: a box's vertical face answers with that restitution and
// leaves the speed along it to the caller's friction; *wall (may be NULL)
// says that was the point's only response.
#define SC_WORLD_ALL_FACES 63
// With a side point's one face: an edge point, chosen to clear a box's corner
// through that face; the edge's other face is not weighed against it.
#define SC_WORLD_EDGE_FLAG 64
uint32_t sc_world_point(double pos[3], double vel[3], const double startPos[3], double dt, double bounceScale,
                        double crashScale, double spinScale, int faceMask, double wallRest, bool *floorHit,
                        bool *scrub, bool *wall);
// A box face's outward normal (module frame) as a face-mask bit.
int sc_world_face_bit(const double n[3]);
// How much deeper (m) than it came in this tick a duct's side point is pushed
// out of a wall at most: deeper is the footprint's (a pose's overlap).
void sc_world_set_side_reach(double metres);
// The boxes within reach of a module-frame region (lo and hi corners, m),
// for the ducts' side points this tick; returns how many.
int sc_world_near(const double lo[3], const double hi[3]);
// Those boxes' vertical edges (module frame: x, y, bottom z, top z, the two
// faces' outward normals along x and y, +-1, and the box's size across each
// of those faces) that reach between zlo and
// zhi within reach (m) of centre across the floor, each with the face mask of
// those faces; up to max, returns how many.
// The tops (+1) and bottoms (-1) of those boxes between zlo and zhi
// (module-frame heights, m), each height and kind once, in order; up to max.
int sc_world_near_levels(double zlo, double zhi, double levels[], int kinds[], int max);
#define SC_WORLD_EDGE_CAP 256
int sc_world_near_edges(const double centre[3], double reach, double zlo, double zhi, double edges[][8], int masks[],
                        int max);
// Whether edge e of the last sc_world_near_edges is the solid's corner at a
// module-frame point by it (neither face a seam there).
bool sc_world_edge_open(int e, const double at[3]);
// Whether a module-frame point is strictly inside a box.
bool sc_world_inside(const double pos[3]);
// Whether a footprint point (module frame) is in the solid: under the floor,
// or inside a box, one standing on the floor reaching down to it.
bool sc_world_point_in(const double pos[3]);
// Whether a module-frame point is inside or on a box (on a seam between boxes
// that meet, say).
bool sc_world_in_solid(const double pos[3]);
// After the footprint points: floor touch and leave events, and triggers at the CG.
void sc_world_after_points(const double com[3], bool floorHit);
// The CG's height above the floor when resting on it (edge state after a
// pose or a floor move).
void sc_world_set_rest_height(double metres);
// The footprint's hull clearance (physical model): the CG's height above the
// floor or the box top underneath, less hullBelow.
double sc_world_hull_clearance(const double pos[3], double hullBelow);
// The footprint's hull (physical model): the convex hull of the four duct
// rims, in order round the base, and the canopy at the apex.
#define SC_HULL_POINTS 5
// A box edge or corner inside the hull (module frame): where the hull holds
// the box off (the box feature inside it: a corner, both ends of an edge
// across a face, or up to four corners of a box top between the rims), the
// unit direction the hull leaves the box by, how deep (m), how much deeper
// than at the start of the tick (m), the push back by what it went deeper
// this tick (along a box face axis, or none; it need not clear an overlap
// carried in from earlier ticks), and the box and that face (world.c axes)
// it is keyed by.
#define SC_HULL_HOLD 4
typedef struct {
    double point[SC_HULL_HOLD][3], normal[3], depth, gain, push[3];
    int points, box, ax, side;
} sc_hull_contact_t;
// The solids the hull (module frame, at the end of the tick after the points'
// push, and at its start) ends the tick deeper inside than it began, with no
// footprint point inside them at the end of the tick or at its start that
// leaves them along the hull's separating axis: up to max contacts, deepest
// first; with more, the one left out is the shallowest whose face a deeper
// one has too, or failing that the shallowest.
int sc_world_hull(const double end[SC_HULL_POINTS][3], const double start[SC_HULL_POINTS][3],
                  sc_hull_contact_t *out, int max);
// A hull contact's world response for the hull point there moving at vel
// (module frame, corrected in place), as a box face hit: bounce, crash and
// friction along the contact's normal, or a box top's soft landing (scrub),
// along the vertical, as on the floor; a contact with no push only stops the
// point moving into the box. normal: the one it used. Queues its CONTACT
// event.
uint32_t sc_world_hull_hit(const sc_hull_contact_t *c, double vel[3], double bounceScale, double crashScale,
                           double spinScale, bool *scrub, double normal[3]);
