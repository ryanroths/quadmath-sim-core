/*
 * World: a floor, axis-aligned boxes and trigger volumes, the ground-clearance
 * query, and contact. Geometry arrives quantised (integer micrometres, module
 * frame) through the ABI, so every host builds the same world.
 *
 * Contact and clearance are ports of quadmath's sim.html hooks (onSubstep
 * H:3150-3204, groundClearance H:3206-3215) and sim-whoop.js resolveDuctHit
 * (W:218-274), with WS = 3.5 world units per metre (H:3090). They run in
 * quadmath's world units, as the originals do, so the same numbers come out:
 *   world (x, y, z) = (-y WS, z WS, -x WS) of the module frame (H:3104).
 * quadmath adds the duct-hit spin kick, built from the world-frame normal and
 * tangent, straight to the body rates (H:3149); so does this port.
 *
 * Deliberate changes from sim.html (PROGRESS.md M4):
 *   - a soft landing on a box top is handled like one on the floor (no duct
 *     hit, the same ground scrub); in sim.html every tick resting on a box top
 *     is a duct hit with a yaw kick, which quadmath's rotational damping hides
 *     and this plant's quadratic-only drag does not
 *   - a contact spin kick leaves no body rate above CONTACT_SPIN_CAP, so a
 *     crash is a crash, never the divergence fault
 *   - a pose (teleport), and the rest pose at boot, set the edge state for the
 *     new position, so arriving inside a trigger or on the floor is not an
 *     entry (quadmath used a 1200 ms wall-clock cooldown on its portals,
 *     sim.html:2276)
 *   - box hits: sim.html resolves the first box containing the point on its
 *     face of least penetration. quadmath's maps build walls, decks, ceilings
 *     and crate stacks from boxes that meet flush or overlap, often on the
 *     module axes the spawn sits on, and per-box resolution treats those
 *     joins as walls: the quad embeds in a seam, slides through it, sinks
 *     through a deck, or is pushed out through a room corner. Here each pass
 *     (up to BOX_PASSES per tick) looks at every box within PAST_WU of the
 *     point and takes the face of least penetration among the faces the point
 *     could have come in through this tick (depth no more than its travel
 *     into that face, to where it was integrated, plus ON_FACE_WU). Within a
 *     box and across boxes, faces the solid continues past (inner faces:
 *     another box within PAST_WU beyond them on all four sides of the point)
 *     rank after surfaces, and so do the faces of a box the tick began deep
 *     inside; an exposed top the tick began on or above ranks first. A point
 *     lying on inner faces of two or more axes at an open concave edge is
 *     not at that box. A point outside a surface face is not at that box; a point
 *     lying on a surface (within FACE_EPS) only touches the box; an inner
 *     face the point lies on is never chosen. A box standing on the
 *     floor has no bottom face; an exposed top wins when the tick began on
 *     or above it (a landing near an edge); a point that began the tick deep
 *     inside a box (a pose) leaves through a surface. The impact is the speed
 *     into the chosen face. CONTACT events are keyed by face (axis, side,
 *     plane), so coplanar split walls are one surface, and a face touched
 *     within CONTACT_GAP_US is the same contact.
 *   - a box whose bottom is within ON_FACE_WU of the floor stands on it: it
 *     has no bottom face and, for a footprint point, reaches down to the
 *     floor plane, so a point on the floor under one lifted more than
 *     PAST_WU is still at it (it slid under the side, 16 mm in 3 s, when
 *     only the bottom face went). This and the next two rules are the
 *     footprint's: quadmath's CG point (the parity model's sc_world_contact)
 *     resolves boxes as it did, bit for bit (plant-world 39; P2 has no boxes
 *     and P5 is the clearance query, so the gate cannot see it)
 *   - an inner face the point crossed this tick where the solid already was
 *     (where its path met the plane, other boxes all round it) ranks after
 *     the other inner faces: the point came in elsewhere, so that face is no
 *     way out. A rim deeper into a concave corner than past a split post's
 *     seam saw only the upper piece, all its faces inner, and the seam, the
 *     shallowest, held it at the split: an invisible ledge
 *   - an inner face is one the point came in through only if it travelled
 *     that deep into it this tick: the ON_FACE_WU allowance is for a point
 *     on a surface, not for a seam beside it. A rim pressed into a split
 *     wall as it rose into the ceiling beside the seam, 20 to 90 um from it
 *     and not moving across it, was pushed onto the seam, a touch whose
 *     friction cut its speed into the ceiling from 2.45 to 2.01 m/s
 *   - the footprint's hull (plant.c): a box edge or corner that ends a tick
 *     inside the convex hull of the five points (a square pyramid, the rims
 *     round the base, the canopy at the apex), with no point inside the box,
 *     is held off. The separating axis of least overlap finds how far; the
 *     push is along the axis of the box face most along it, as a point's
 *     is, and the box feature inside the hull (a corner, or both ends of an
 *     edge across a face: one point there rocked the quad) is one or two
 *     contacts with a box hit's response, keyed by that face; a soft one on
 *     a box top is along the vertical, as on the floor (along the hull's
 *     tilted face it walked a quad resting on a table edge sideways).
 *     A box the hull began the tick in at least as deep (a pose, a post
 *     through the quad's middle) is not one it is passing into; one it began
 *     in less deep is pushed back only as far as it went deeper this tick
 *     (pushed out whole, a carried 19 mm overlap threw the quad into the
 *     next post, and that one threw it back: 20 to 40 mm one-tick pushes),
 *     and one a footprint point began the tick inside is left to that point
 *     (held at its depth, a thin wall through the quad kept a rim 9.9 mm
 *     inside it). Pressed up
 *     under a shelf shallower than the quad against a wall, the shelf's
 *     front edge passed between the leading rim and the rest and the quad
 *     swung over it onto the shelf (12 mm of edge inside the hull); set down
 *     level with its CG 10 mm behind a table edge, it tipped over the edge
 *     with the edge 9 mm into its body
 *   - the hull meets solids, not box pieces: boxes that meet or overlap
 *     along one axis with the same extent on the other two (a wall, table or
 *     shelf in pieces) are the one box they form. Piece by piece a seam was a
 *     face: a sliver of the far piece across a split table's seam pushed the
 *     quad up to 5 mm sideways in a tick with a phantom contact and a roll
 *     kick, and a split shelf held its edge 2.2 um inside the hull. Solids,
 *     and equally deep hull contacts, go in order of position, not the
 *     order the map lists the boxes in: the contacts are taken in order in
 *     plant.c's sweeps, and swapping two pieces in the list moved the quad
 *     44 um
 *   - a box standing on the floor reaches down through it for the hull, as
 *     it has no bottom face for a point: the separating-axis test is against
 *     the box extended down, so no way out takes the hull down. A post's
 *     vertical edge meeting a sloped side of the pyramid (about 0.79
 *     vertical) pushed the quad down through the floor: rims 5.75 mm under
 *     it skimming into a post, 25 mm under it (and held there, the floor
 *     lifting and the hull pushing down every tick) posed beside one
 *   - a tick that enters a trigger ends the tick run (sc_tick_stop), so the
 *     host's response lands on the next tick at any frame time
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "sc.h"
#include "plant.h"

#define WS 3.5
#define FLOOR_PAD_M 0.01            // QP:90 FLOOR_CLEARANCE_M
#define HARD_LANDING_WU 4.5         // H:3167, world units per second
#define TUMBLE_DECAY 7.3            // H:3199, per second
#define BOUNCE_STR 0.75             // W:17 DEFAULT_WHOOP.bounceStr
#define CRASH_SPEED_WU 9.0          // W:18 DEFAULT_WHOOP.crashSpeed
#define CONTACT_SPIN_CAP 150.0      // rad/s, below the plant's 200 rad/s divergence guard
#define ON_FACE_WU (1e-4 * WS)      // 0.1 mm: "on" a face, against a tick's sink under gravity
#define FACE_EPS 1e-7               // world units: "lying on" a face
#define PAST_WU (5e-6 * WS)         // 5 um past a face: the solid continues if a box is there
#define BOX_PASSES 3
#define CONTACT_FACES 8
#define CONTACT_GAP_US 50000        // a face touched again within 50 ms: the same contact

#define SC_WORLD_BOX_CAP 16384
#define SC_WORLD_TRIGGER_CAP 256

typedef struct {
    double min[3], max[3];          // world units (quadmath's axes)
    int kind, id;
} scBox_t;

static scBox_t boxes[SC_WORLD_BOX_CAP];
static int boxCount;
static bool solidsStale = true;     // the footprint hull's solids need building (boxes changed)
static scBox_t triggers[SC_WORLD_TRIGGER_CAP];
static bool triggerInside[SC_WORLD_TRIGGER_CAP];
static int triggerCount;
static double floorZ;               // module-frame height of the ground plane, m
static double restHeight = FLOOR_PAD_M; // the CG above the floor at rest, m
static bool onFloor;
// Faces touched recently, so a CONTACT event marks a new touch only.
typedef struct {
    int ax, side;
    double plane;
    uint64_t lastUs;
    bool crashed;                   // the last CONTACT event for it was a crash
} scFace_t;
static scFace_t touched[CONTACT_FACES];
static int touchedCount;

static void mod2world(const double m[3], double w[3])
{
    w[0] = -m[1] * WS;
    w[1] = m[2] * WS;
    w[2] = -m[0] * WS;
}

static void world2mod(const double w[3], double m[3])
{
    m[0] = -w[2] / WS;
    m[1] = -w[0] / WS;
    m[2] = w[1] / WS;
}

// A module-frame box in micrometres to quadmath's world-unit AABB.
static void boxFromUm(const int32_t um[6], scBox_t *b)
{
    const double lo[3] = { um[0] * 1e-6, um[1] * 1e-6, um[2] * 1e-6 };
    const double hi[3] = { um[3] * 1e-6, um[4] * 1e-6, um[5] * 1e-6 };
    b->min[0] = -hi[1] * WS;
    b->max[0] = -lo[1] * WS;
    b->min[1] = lo[2] * WS;
    b->max[1] = hi[2] * WS;
    b->min[2] = -hi[0] * WS;
    b->max[2] = -lo[0] * WS;
}

static bool contains(const scBox_t *b, const double w[3])
{
    return w[0] >= b->min[0] && w[0] <= b->max[0] && w[1] >= b->min[1] && w[1] <= b->max[1]
           && w[2] >= b->min[2] && w[2] <= b->max[2];
}

void sc_world_reset(void)
{
    boxCount = 0;
    solidsStale = true;
    triggerCount = 0;
    floorZ = 0;
    onFloor = true;
    touchedCount = 0;
    memset(triggerInside, 0, sizeof(triggerInside));
}

double sc_world_floor_z(void)
{
    return floorZ;
}

void sc_world_set_floor(int32_t zUm)
{
    floorZ = zUm * 1e-6;
}

void sc_world_set_rest_height(double metres)
{
    restHeight = metres;
}

int sc_world_add_box(const int32_t um[6], int kind, int id)
{
    if (boxCount >= SC_WORLD_BOX_CAP) {
        return SC_ERR_FULL;
    }
    if (um[0] > um[3] || um[1] > um[4] || um[2] > um[5]) {
        return SC_ERR_BAD_ARG;
    }
    boxFromUm(um, &boxes[boxCount]);
    boxes[boxCount].kind = kind;
    boxes[boxCount].id = id;
    solidsStale = true;
    return boxCount++;
}

int sc_world_add_trigger(const int32_t um[6], int id)
{
    if (triggerCount >= SC_WORLD_TRIGGER_CAP) {
        return SC_ERR_FULL;
    }
    if (um[0] > um[3] || um[1] > um[4] || um[2] > um[5]) {
        return SC_ERR_BAD_ARG;
    }
    boxFromUm(um, &triggers[triggerCount]);
    triggers[triggerCount].id = id;
    triggerInside[triggerCount] = false;
    return triggerCount++;
}

// Height above whatever is directly underneath: the floor raised by floorPad,
// or the highest box top below the point.
static double clearanceWith(const double pos[3], double floorPad)
{
    double w[3];
    mod2world(pos, w);
    double top = (floorZ + floorPad) * WS;
    for (int i = 0; i < boxCount; i++) {
        const scBox_t *b = &boxes[i];
        if (w[0] >= b->min[0] && w[0] <= b->max[0] && w[2] >= b->min[2] && w[2] <= b->max[2] && b->max[1] <= w[1]
            && b->max[1] > top) {
            top = b->max[1];
        }
    }
    return (w[1] - top) / WS;
}

// quadmath's CG point (H:3206-3215, the same expression): the floor counts
// FLOOR_PAD_M up, where its CG rests, and a box top at the top, where it
// rests there.
double sc_world_clearance_at(const double pos[3])
{
    return clearanceWith(pos, FLOOR_PAD_M);
}

// The footprint: the hull's clearance, from the CG's height above what is
// underneath less hullBelow, the same datum on the floor and on a box top.
double sc_world_hull_clearance(const double pos[3], double hullBelow)
{
    return clearanceWith(pos, 0) - hullBelow;
}

static double vdot(const double a[3], const double b[3])
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// resolveDuctHit (W:218-274) with quadmath's default whoop settings and this
// airframe's scales; no rng. vel in world units, omega in body rad/s.
static bool ductHit(double vel[3], double omega[3], const double n[3], double into, bool floor,
                    double bounceScale, double crashScale, double spinScale)
{
    const double vn = vdot(vel, n);
    const double crashAt = CRASH_SPEED_WU * crashScale;
    const bool crashed = into > crashAt;
    double rest = crashed ? 0.10 : 0.24 + 0.11 * BOUNCE_STR * bounceScale;
    if (floor && !crashed) {
        rest *= 0.55;
    }
    const double leave = vn < 0 ? vn : -into;
    double next[3];
    for (int k = 0; k < 3; k++) {
        next[k] = vel[k] + n[k] * (-(1 + rest) * leave);
    }
    const double nn = vdot(next, n);
    double tan[3];
    for (int k = 0; k < 3; k++) {
        tan[k] = next[k] - n[k] * nn;
    }
    const double tanDamp = crashed ? 0.55 : 0.82;
    for (int k = 0; k < 3; k++) {
        vel[k] = n[k] * nn + tan[k] * tanDamp;
    }
    if (!omega) {
        return crashed;     // a footprint point: its lever arm gives the spin
    }
    const double spinK = (crashed ? 1.6 : 0.48) * BOUNCE_STR * spinScale * fmin(into, 28);
    double kick[3] = {
        (n[1] * tan[2] - n[2] * tan[1]) * spinK * 0.08,
        (n[2] * tan[0] - n[0] * tan[2]) * spinK * 0.08,
        (n[0] * tan[1] - n[1] * tan[0]) * spinK * 0.10,
    };
    kick[0] += n[2] * spinK * 0.035 + (crashed ? spinK * 0.06 : 0);
    kick[1] += n[0] * spinK * 0.035;
    kick[2] += spinK * (crashed ? 0.08 : 0.025);
    if (floor) {
        kick[0] += -tan[1] * spinK * 0.05;
        kick[1] += tan[0] * spinK * 0.05;
    }
    for (int k = 0; k < 3; k++) {
        omega[k] += kick[k];
    }
    // The cap is on |omega|: with no torque the body keeps |omega_xy| and
    // omega_z (Ixx = Iyy), so no axis passes the cap in the tumble that follows.
    const double mag = sqrt(vdot(omega, omega));
    if (mag > CONTACT_SPIN_CAP) {
        for (int k = 0; k < 3; k++) {
            omega[k] *= CONTACT_SPIN_CAP / mag;
        }
    }
    return crashed;
}

static void contactEvent(int kind, int id, double into, bool crashed)
{
    const double values[3] = { id, into / WS, crashed ? 1 : 0 };
    sc_event_push(kind, values, 3);
}

// Floor and trigger edge state for a quad at pos, as if it had always been
// there.
void sc_world_edge_sync(const double pos[3])
{
    double cp[3];
    mod2world(pos, cp);
    // One micrometre of tolerance: the pose is quantised to micrometres and
    // the floor plane is not, so a pose at resting height can land a rounding
    // step above it. Triggers are judged where the floor will put the quad.
    const double floorY = (floorZ + restHeight) * WS;
    onFloor = cp[1] <= floorY + 1e-6 * WS;
    if (cp[1] < floorY) {
        cp[1] = floorY;
    }
    for (int i = 0; i < triggerCount; i++) {
        triggerInside[i] = contains(&triggers[i], cp);
    }
}

// A pose: the edge state for the new position, so the next contact pass
// reports only what happens after it. A box the pose lands in still pushes
// the quad out with a hit, so that is reported.
void sc_world_pose_sync(const double pos[3])
{
    sc_world_edge_sync(pos);
    touchedCount = 0;
}

// Whether a box other than skip has the point strictly inside it.
static bool insideAnother(int skip, const double p[3])
{
    for (int j = 0; j < boxCount; j++) {
        const scBox_t *o = &boxes[j];
        if (j != skip && p[0] > o->min[0] && p[0] < o->max[0] && p[1] > o->min[1] && p[1] < o->max[1]
            && p[2] > o->min[2] && p[2] < o->max[2]) {
            return true;
        }
    }
    return false;
}

// A sample along a face kept on the face's own rectangle: beyond its edge it
// says nothing about this face.
static double alongFace(const scBox_t *b, int t, double v)
{
    const double lo = b->min[t] + PAST_WU, hi = b->max[t] - PAST_WU;
    if (lo > hi) {
        return (b->min[t] + b->max[t]) / 2;
    }
    return v < lo ? lo : v > hi ? hi : v;
}

// A box standing on the floor (its bottom within ON_FACE_WU of the floor
// plane floorY) has no bottom face.
static bool grounded(const scBox_t *b, double floorY)
{
    return b->min[1] <= floorY + ON_FACE_WU;
}

// Whether a box is within PAST_WU of the point on every axis. reach (a
// footprint point): a box standing on the floor reaches down to the floor
// plane, so a point on the floor under one lifted up to ON_FACE_WU is at it.
// quadmath's CG point (the parity model) keeps the box's own bounds.
static bool nearBox(const scBox_t *b, const double w[3], double floorY, bool reach)
{
    return w[0] >= b->min[0] - PAST_WU && w[0] <= b->max[0] + PAST_WU && w[2] >= b->min[2] - PAST_WU
           && w[2] <= b->max[2] + PAST_WU && w[1] <= b->max[1] + PAST_WU
           && (w[1] >= b->min[1] - PAST_WU || (reach && grounded(b, floorY) && w[1] >= floorY - PAST_WU));
}

// Whether the point is inside the union of the boxes with ON_FACE_WU to spare
// in every direction: a pose deep in the solid (on a seam plane, say).
static bool deepInSolid(const double p[3])
{
    for (int k = 0; k < 27; k++) {
        const double q[3] = { p[0] + (k % 3 - 1) * ON_FACE_WU, p[1] + (k / 3 % 3 - 1) * ON_FACE_WU,
                              p[2] + (k / 9 - 1) * ON_FACE_WU };
        int j = 0;
        while (j < boxCount && !contains(&boxes[j], q)) {
            j++;
        }
        if (j == boxCount) {
            return false;
        }
    }
    return true;
}

// Whether the solid continues past box skip's face at plane (axis ax, outward
// side) near the point: four points PAST_WU beyond the face, offset diagonally
// along the face, are all inside other boxes. Four samples, because the point
// may lie on the seam of the boxes beyond, or on the edge of a slab meeting
// the face.
static bool covered(int skip, const double cp[3], int ax, int side, double plane)
{
    const scBox_t *b = &boxes[skip];
    const int t0 = (ax + 1) % 3, t1 = (ax + 2) % 3;
    for (int s0 = -1; s0 <= 1; s0 += 2) {
        for (int s1 = -1; s1 <= 1; s1 += 2) {
            double q[3] = { cp[0], cp[1], cp[2] };
            q[ax] = plane + side * PAST_WU;
            q[t0] = alongFace(b, t0, cp[t0] + s0 * PAST_WU);
            q[t1] = alongFace(b, t1, cp[t1] + s1 * PAST_WU);
            if (!insideAnother(skip, q)) {
                return false;
            }
        }
    }
    return true;
}

// Whether the point crossed box skip's inner face at plane (axis ax, outward
// side) this tick inside the solid: where its path from start to end crossed
// the plane, four points PAST_WU outside the face, offset diagonally along it,
// are all inside other boxes. It came in somewhere else (a split post's seam
// crossed in a concave corner), so the face is not its way back out.
static bool crossedInside(int skip, const double start[3], const double end[3], int ax, int side, double plane)
{
    if (side > 0 ? !(start[ax] >= plane && end[ax] < plane) : !(start[ax] <= plane && end[ax] > plane)) {
        return false;                   // not crossed on the way in this tick
    }
    const double f = (plane - start[ax]) / (end[ax] - start[ax]);
    const int t0 = (ax + 1) % 3, t1 = (ax + 2) % 3;
    for (int s0 = -1; s0 <= 1; s0 += 2) {
        for (int s1 = -1; s1 <= 1; s1 += 2) {
            double q[3];
            q[ax] = plane + side * PAST_WU;
            q[t0] = start[t0] + f * (end[t0] - start[t0]) + s0 * PAST_WU;
            q[t1] = start[t1] + f * (end[t1] - start[t1]) + s1 * PAST_WU;
            if (!insideAnother(skip, q)) {
                return false;
            }
        }
    }
    return true;
}

// A touch of a box face: a CONTACT event unless the same face (axis, side,
// plane) was touched within CONTACT_GAP_US. upgrade (the footprint): a crash
// on a face whose last event was not one is reported even inside the gap, so
// a second rim slamming down just after a softer first one is still a crash.
static void touchFace(int ax, int side, double plane, int id, double into, bool crashed, bool upgrade)
{
    int oldest = 0;
    for (int k = 0; k < touchedCount; k++) {
        scFace_t *f = &touched[k];
        if (f->ax == ax && f->side == side && f->plane == plane) {
            if (sc_time_us - f->lastUs > CONTACT_GAP_US) {
                contactEvent(SC_EVENT_CONTACT, id, into, crashed);
                f->crashed = crashed;
            } else if (upgrade && crashed && !f->crashed) {
                contactEvent(SC_EVENT_CONTACT, id, into, true);
                f->crashed = true;
            }
            f->lastUs = sc_time_us;
            return;
        }
        if (f->lastUs < touched[oldest].lastUs) {
            oldest = k;
        }
    }
    contactEvent(SC_EVENT_CONTACT, id, into, crashed);
    const scFace_t f = { ax, side, plane, sc_time_us, crashed };
    touched[touchedCount < CONTACT_FACES ? touchedCount++ : oldest] = f;
}

// One contact point against the floor and the boxes (H:3150-3204, with the
// changes above), in world units. pad: the floor plane is raised by
// FLOOR_PAD_M for quadmath's CG point, and not for a footprint point, which is
// the hull itself. omega: body rates for the duct-hit spin kick, or NULL for
// a footprint point. A footprint's hard floor hits are keyed like faces, so
// four ducts landing together are one contact.
static uint32_t resolvePoint(double cp[3], double cv[3], const double start[3], double dt, double bounceScale,
                             double crashScale, double spinScale, double omega[3], bool pad, bool *floorHitOut,
                             bool *scrubOut)
{
    const double floorY = (floorZ + (pad ? FLOOR_PAD_M : 0)) * WS;
    uint32_t flags = 0;
    bool floorHit = false;
    if (cp[1] < floorY) {
        const double impact = -cv[1];
        cp[1] = floorY;
        floorHit = true;
        if (impact > HARD_LANDING_WU) {
            static const double up[3] = { 0, 1, 0 };
            const bool crashed = ductHit(cv, omega, up, impact, true, bounceScale, crashScale, spinScale);
            if (pad) {
                contactEvent(SC_EVENT_CONTACT, -1, impact, crashed);
            } else {
                touchFace(1, 1, floorY, -1, impact, crashed, true);
            }
        } else {
            cv[1] = fmax(cv[1], 0);
            cv[0] *= 0.85;
            cv[2] *= 0.85;
        }
    }
    bool scrub = floorHit;
    // Where the tick integrated the point to (after the floor): travel into a
    // face is measured to here, not to where an earlier pass pushed it.
    const double tickPos[3] = { cp[0], cp[1], cp[2] };
    // A pose deep in the solid where no box sees a way out (on a seam plane):
    // pass 0 is run again treating every nearby box as one the tick began in.
    bool forceBegan = false;
    for (int pass = 0; pass < BOX_PASSES; pass++) {
        int bestBox = -1, bestAxis = 0, bestSide = 0;
        double bestDepth = INFINITY;
        int bestRank = 4;
        bool anyNear = false;
        for (int i = 0; i < boxCount; i++) {
            const scBox_t *b = &boxes[i];
            // Within PAST_WU: a point nanometres off a slab that meets a wall
            // must still find the slab's top or bottom.
            if (!nearBox(b, cp, floorY, !pad)) {
                continue;
            }
            anyNear = true;
            const bool onFloor = grounded(b, floorY);
            // Began the tick deep inside (a pose): leave through a surface.
            bool began = true;
            if (forceBegan) {
                began = nearBox(b, start, floorY, !pad);
            } else {
                for (int a = 0; a < 3 && began; a++) {
                    began = start[a] > b->min[a] + ON_FACE_WU && start[a] < b->max[a] - ON_FACE_WU;
                }
            }
            bool outside = false;
            int touchAxis = -1, touchSide = 0;
            int onInner = 0;
            double pastInner[3] = { 0, 0, 0 };
            int faceAxis = 0, faceSide = 0;
            double faceDepth = INFINITY;
            int faceRank = 4;
            for (int ax = 0; ax < 3 && !outside; ax++) {
                for (int side = -1; side <= 1; side += 2) {
                    if (ax == 1 && side < 0 && onFloor) {
                        continue;           // standing on the floor: no bottom face
                    }
                    const double plane = side > 0 ? b->max[ax] : b->min[ax];
                    const double depth = side > 0 ? plane - cp[ax] : cp[ax] - plane;
                    if (depth <= FACE_EPS) {
                        if (covered(i, cp, ax, side, plane)) {
                            // An inner face (a seam) it lies on: never chosen.
                            if (!(onInner & (1 << ax))) {
                                onInner |= 1 << ax;
                                pastInner[ax] = plane + side * PAST_WU;
                            }
                            continue;
                        }
                        if (depth < 0) {
                            outside = true;     // outside one of its surfaces: not at this box
                            break;
                        }
                        if (touchAxis < 0) {
                            touchAxis = ax;     // lying on its surface: touching
                            touchSide = side;
                        }
                        continue;
                    }
                    // A tick that began on or above an exposed top lands on it.
                    // Exposed means nothing stands on it right above the point,
                    // nor on the four samples around it (a point on the seam
                    // of two boxes standing on this top).
                    const double above[3] = { cp[0], plane + PAST_WU, cp[2] };
                    const bool top = ax == 1 && side > 0 && start[1] >= b->max[1] - ON_FACE_WU
                                     && !insideAnother(i, above) && !covered(i, cp, ax, side, plane);
                    bool inner = false, crossedIn = false;
                    if (began) {
                        if (covered(i, cp, ax, side, plane)) {
                            continue;
                        }
                    } else if (!top) {
                        const double travel = side > 0 ? start[ax] - tickPos[ax] : tickPos[ax] - start[ax];
                        if (depth > fmax(0, travel) + ON_FACE_WU) {
                            continue;           // farther than the point came in this tick
                        }
                        inner = covered(i, cp, ax, side, plane);
                        // Footprint points only (header); quadmath's CG point
                        // (pad, the parity model) keeps the rules it had.
                        if (!pad && inner && depth > fmax(0, travel) + FACE_EPS) {
                            continue;           // a seam it did not come through: no slack
                        }
                        crossedIn = !pad && inner && crossedInside(i, start, tickPos, ax, side, plane);
                    }
                    // Top first, then surfaces, then inner faces, those it
                    // crossed inside the solid last; then depth.
                    const int rank = top ? 0 : !inner ? 1 : crossedIn ? 3 : 2;
                    if (rank < faceRank || (rank == faceRank && depth < faceDepth)) {
                        faceAxis = ax;
                        faceSide = side;
                        faceDepth = depth;
                        faceRank = rank;
                    }
                }
            }
            if (outside) {
                continue;
            }
            if (onInner & (onInner - 1)) {
                // On inner faces of two or more axes: an edge of this box. If
                // the solid does not continue diagonally past it, the point is
                // in the open at a concave corner, not at this box.
                double q[3] = { cp[0], cp[1], cp[2] };
                int freeAx = -1;
                bool open = false;
                for (int a = 0; a < 3; a++) {
                    if (onInner & (1 << a)) {
                        q[a] = pastInner[a];
                    } else {
                        freeAx = a;
                    }
                }
                if (freeAx < 0) {
                    open = !insideAnother(i, q);
                } else {
                    for (int sd = -1; sd <= 1 && !open; sd += 2) {
                        q[freeAx] = cp[freeAx] + sd * PAST_WU;
                        open = !insideAnother(i, q);
                    }
                }
                if (open) {
                    continue;
                }
            }
            if (touchAxis >= 0) {
                flags |= 2;
                const double plane = touchSide > 0 ? b->max[touchAxis] : b->min[touchAxis];
                touchFace(touchAxis, touchSide, plane, b->id, fmax(0, -touchSide * cv[touchAxis]), false, !pad);
                continue;
            }
            // Across boxes: an exposed top first, then a surface of a box the
            // tick did not begin inside, then the rest (inner faces crossed
            // inside the solid last), then depth.
            const int boxRank = faceRank == 0 ? 0 : began ? 2 : faceRank;
            if (faceSide != 0 && (boxRank < bestRank || (boxRank == bestRank && faceDepth < bestDepth))) {
                bestBox = i;
                bestAxis = faceAxis;
                bestSide = faceSide;
                bestDepth = faceDepth;
                bestRank = boxRank;
            }
        }
        if (pass == 0 && !forceBegan && anyNear && (bestBox < 0 || (bestRank >= 2 && bestAxis == 1))
            && deepInSolid(start)) {
            forceBegan = true;
            pass--;
            continue;
        }
        forceBegan = false;
        if (bestBox < 0) {
            break;
        }
        flags |= 2;
        const scBox_t *b = &boxes[bestBox];
        double n[3] = { 0, 0, 0 };
        n[bestAxis] = bestSide;
        const double plane = bestSide > 0 ? b->max[bestAxis] : b->min[bestAxis];
        cp[bestAxis] = plane;
        const double into = fmax(0, -bestSide * cv[bestAxis]);
        const bool top = bestAxis == 1 && bestSide > 0;
        bool crashed = false;
        if (top && into <= HARD_LANDING_WU) {
            // Resting on or landing softly on a box top: as on the floor.
            cv[1] = fmax(cv[1], 0);
            cv[0] *= 0.85;
            cv[2] *= 0.85;
            scrub = true;
        } else {
            crashed = ductHit(cv, omega, n, into, top, bounceScale, crashScale, spinScale);
        }
        touchFace(bestAxis, bestSide, plane, b->id, into, crashed, !pad);
    }
    if (floorHit) {
        flags |= 1;
    }
    *floorHitOut = floorHit;
    *scrubOut = scrub;
    return flags;
}

static void floorEdgeAndTriggers(const double cp[3], bool floorHit)
{
    if (floorHit != onFloor) {
        const double id = -1;
        sc_event_push(floorHit ? SC_EVENT_FLOOR_TOUCH : SC_EVENT_FLOOR_LEAVE, &id, 1);
        onFloor = floorHit;
    }
    for (int i = 0; i < triggerCount; i++) {
        const bool inside = contains(&triggers[i], cp);
        if (inside && !triggerInside[i]) {
            const double id = triggers[i].id;
            sc_event_push(SC_EVENT_TRIGGER, &id, 1);
            sc_tick_stop = true;
        }
        triggerInside[i] = inside;
    }
}

// quadmath's model: the CG is the contact point (floor raised by FLOOR_PAD_M,
// duct-hit spin kick on the body rates). The parity model uses this.
uint32_t sc_world_contact(double pos[3], double vel[3], double omega[3], double dt, double bounceScale,
                          double crashScale, double spinScale)
{
    double cp[3], cv[3];
    mod2world(pos, cp);
    mod2world(vel, cv);
    // Where the point was at the start of the tick, before the floor moves it.
    double start[3];
    for (int a = 0; a < 3; a++) {
        start[a] = cp[a] - cv[a] * dt;
    }
    bool floorHit, scrub;
    const uint32_t flags = resolvePoint(cp, cv, start, dt, bounceScale, crashScale, spinScale, omega, true,
                                        &floorHit, &scrub);
    world2mod(cp, pos);
    world2mod(cv, vel);
    if (scrub) {
        // Ground scrub: a tumble settles on contact (H:3196-3203).
        const double k = exp(-dt * TUMBLE_DECAY);
        omega[0] *= k;
        omega[1] *= k;
        omega[2] *= k;
    }
    floorEdgeAndTriggers(cp, floorHit);
    return flags;
}

uint32_t sc_world_point(double pos[3], double vel[3], const double startPos[3], double dt, double bounceScale,
                        double crashScale, double spinScale, bool *floorHit, bool *scrub)
{
    double cp[3], cv[3], start[3];
    mod2world(pos, cp);
    mod2world(vel, cv);
    mod2world(startPos, start);
    const double cp0[3] = { cp[0], cp[1], cp[2] }, cv0[3] = { cv[0], cv[1], cv[2] };
    const uint32_t flags = resolvePoint(cp, cv, start, dt, bounceScale, crashScale, spinScale, NULL, false,
                                        floorHit, scrub);
    // Only the components the world changed: the x WS round trip is not exact,
    // and its last-bit noise on an untouched axis would read as a push.
    if (cp[2] != cp0[2]) {
        pos[0] = -cp[2] / WS;
    }
    if (cp[0] != cp0[0]) {
        pos[1] = -cp[0] / WS;
    }
    if (cp[1] != cp0[1]) {
        pos[2] = cp[1] / WS;
    }
    if (cv[2] != cv0[2]) {
        vel[0] = -cv[2] / WS;
    }
    if (cv[0] != cv0[0]) {
        vel[1] = -cv[0] / WS;
    }
    if (cv[1] != cv0[1]) {
        vel[2] = cv[1] / WS;
    }
    return flags;
}

// The footprint's hull. Five points can straddle a box edge: pressed up under
// a shelf shallower than the quad, the shelf's front edge passed between the
// leading rim and the rest of the footprint. The convex hull of the points is
// a square pyramid (the duct rims round the base, the canopy at the apex);
// a box edge or corner that ends a tick inside it is a contact like a
// point's, held at the box feature inside the hull.
typedef struct {
    double v[SC_HULL_POINTS][3];    // world units: the rims round the base, then the apex
    double lo[3], hi[3];
    double n[5][3], d[5];           // the base and four sides: n.x <= d inside
    bool faces;                     // n and d set
} scHull_t;

static const int HULL_EDGES[8][2] = { { 0, 1 }, { 1, 2 }, { 2, 3 }, { 3, 0 }, { 0, 4 }, { 1, 4 }, { 2, 4 }, { 3, 4 } };

// The hull meets solids, not box pieces: boxes that meet or overlap along
// one axis (within PAST_WU) with the same extent on the other two (a wall,
// table or shelf in pieces) are one solid, the box they form, so a seam is
// neither a face nor a way out. Per piece, a sliver of the far piece across a
// split table's seam pushed the quad sideways off the seam with a roll kick,
// and each piece held its own end of the edge. Built when the boxes change:
// merged along x, then y, then z, each in order of position, until a round
// merges nothing, so the solids, their order and the order of each one's
// pieces follow where the boxes are, not the order the map lists them in
// (the order of the hull's contacts is the order of plant.c's sweeps).
static scBox_t solids[SC_WORLD_BOX_CAP];   // indexed by the solid's first box; extents only
static int solidOf[SC_WORLD_BOX_CAP];      // the solid a box is part of
static int solidFirst[SC_WORLD_BOX_CAP];   // a solid's first piece; pieceNext links the rest
static int pieceNext[SC_WORLD_BOX_CAP];
static int solidOrder[SC_WORLD_BOX_CAP];   // the solids, in order of position
static int pieceOrder[SC_WORLD_BOX_CAP];
static int solidCount;
static int mergeAx;

// Extents a before b by position: min corner, then max corner, x y z.
static int byPosition(const scBox_t *a, const scBox_t *b)
{
    for (int k = 0; k < 3; k++) {
        if (a->min[k] != b->min[k]) {
            return a->min[k] < b->min[k] ? -1 : 1;
        }
    }
    for (int k = 0; k < 3; k++) {
        if (a->max[k] != b->max[k]) {
            return a->max[k] < b->max[k] ? -1 : 1;
        }
    }
    return 0;
}

static int solidsByPosition(const void *pa, const void *pb)
{
    const int i = *(const int *)pa, j = *(const int *)pb;
    const int c = byPosition(&solids[i], &solids[j]);
    return c ? c : (i > j) - (i < j);
}

static int piecesByPosition(const void *pa, const void *pb)
{
    const int i = *(const int *)pa, j = *(const int *)pb;
    const int c = byPosition(&boxes[i], &boxes[j]);
    return c ? c : (i > j) - (i < j);
}

// For a merge along mergeAx: by the extent on the other two axes, then along it.
static int solidsByCross(const void *pa, const void *pb)
{
    const int i = *(const int *)pa, j = *(const int *)pb;
    const scBox_t *a = &solids[i], *b = &solids[j];
    const int t0 = (mergeAx + 1) % 3, t1 = (mergeAx + 2) % 3;
    const double ka[6] = { a->min[t0], a->max[t0], a->min[t1], a->max[t1], a->min[mergeAx], a->max[mergeAx] };
    const double kb[6] = { b->min[t0], b->max[t0], b->min[t1], b->max[t1], b->min[mergeAx], b->max[mergeAx] };
    for (int k = 0; k < 6; k++) {
        if (ka[k] != kb[k]) {
            return ka[k] < kb[k] ? -1 : 1;
        }
    }
    return (i > j) - (i < j);
}

static void buildSolids(void)
{
    for (int j = 0; j < boxCount; j++) {
        solids[j] = boxes[j];
        solidOf[j] = j;
    }
    for (bool merged = true; merged;) {
        merged = false;
        for (mergeAx = 0; mergeAx < 3; mergeAx++) {
            int n = 0;
            for (int j = 0; j < boxCount; j++) {
                if (solidOf[j] == j) {
                    solidOrder[n++] = j;
                }
            }
            qsort(solidOrder, n, sizeof(int), solidsByCross);
            const int t0 = (mergeAx + 1) % 3, t1 = (mergeAx + 2) % 3;
            for (int k = 0; k < n;) {
                scBox_t *s = &solids[solidOrder[k]];
                int m = k + 1;
                for (; m < n; m++) {
                    const scBox_t *o = &solids[solidOrder[m]];
                    if (o->min[t0] != s->min[t0] || o->max[t0] != s->max[t0] || o->min[t1] != s->min[t1]
                        || o->max[t1] != s->max[t1] || o->min[mergeAx] > s->max[mergeAx] + PAST_WU) {
                        break;
                    }
                    s->max[mergeAx] = fmax(s->max[mergeAx], o->max[mergeAx]);
                    solidOf[solidOrder[m]] = solidOrder[k];
                    merged = true;
                }
                k = m;
            }
        }
    }
    solidCount = 0;
    for (int j = 0; j < boxCount; j++) {
        int r = j;
        while (solidOf[r] != r) {
            r = solidOf[r];
        }
        solidOf[j] = r;
        if (r == j) {
            solidOrder[solidCount++] = j;
            solidFirst[j] = -1;
        }
        pieceOrder[j] = j;
    }
    qsort(solidOrder, solidCount, sizeof(int), solidsByPosition);
    qsort(pieceOrder, boxCount, sizeof(int), piecesByPosition);
    for (int k = boxCount - 1; k >= 0; k--) {
        const int j = pieceOrder[k];
        pieceNext[j] = solidFirst[solidOf[j]];
        solidFirst[solidOf[j]] = j;
    }
    solidsStale = false;
}

// The piece of solid s whose face (axis ax, side) is the solid's there and
// holds world point w (within PAST_WU along the face), the first by position:
// the box a hull contact on that face is reported on.
static int pieceAt(int s, int ax, int side, const double w[3])
{
    const double plane = side > 0 ? solids[s].max[ax] : solids[s].min[ax];
    const int t0 = (ax + 1) % 3, t1 = (ax + 2) % 3;
    int onPlane = -1;
    for (int j = solidFirst[s]; j >= 0; j = pieceNext[j]) {
        const scBox_t *b = &boxes[j];
        if ((side > 0 ? b->max[ax] : b->min[ax]) != plane) {
            continue;
        }
        if (w[t0] >= b->min[t0] - PAST_WU && w[t0] <= b->max[t0] + PAST_WU && w[t1] >= b->min[t1] - PAST_WU
            && w[t1] <= b->max[t1] + PAST_WU) {
            return j;
        }
        if (onPlane < 0) {
            onPlane = j;
        }
    }
    return onPlane >= 0 ? onPlane : solidFirst[s];
}

static void vcross(const double a[3], const double b[3], double out[3])
{
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
}

// The hull's corners (module frame in) in world units, and its bounds.
static void hullAt(const double mod[SC_HULL_POINTS][3], scHull_t *h)
{
    for (int k = 0; k < SC_HULL_POINTS; k++) {
        mod2world(mod[k], h->v[k]);
        for (int a = 0; a < 3; a++) {
            h->lo[a] = k ? fmin(h->lo[a], h->v[k][a]) : h->v[k][a];
            h->hi[a] = k ? fmax(h->hi[a], h->v[k][a]) : h->v[k][a];
        }
    }
    h->faces = false;
}

// Its faces, the first time a box is near.
static void hullFaces(scHull_t *h)
{
    if (h->faces) {
        return;
    }
    double c[3] = { 0, 0, 0 };
    for (int k = 0; k < SC_HULL_POINTS; k++) {
        for (int a = 0; a < 3; a++) {
            c[a] += h->v[k][a] / SC_HULL_POINTS;
        }
    }
    for (int f = 0; f < 5; f++) {
        const double *a = h->v[f ? f - 1 : 0], *b = h->v[f ? f % 4 : 1], *e = h->v[f ? 4 : 2];
        const double ab[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] };
        const double ae[3] = { e[0] - a[0], e[1] - a[1], e[2] - a[2] };
        const double ac[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
        double n[3];
        vcross(ab, ae, n);
        const double len = sqrt(vdot(n, n)) * (vdot(n, ac) > 0 ? -1 : 1);
        for (int k = 0; k < 3; k++) {
            h->n[f][k] = n[k] / len;
        }
        h->d[f] = vdot(h->n[f], a);
    }
    h->faces = true;
}

// Box b against hull h along the unit axis a: how far the hull must move along
// a (dir 1) or against it (dir -1) to clear the box, the shorter. A box
// standing on the floor (standing) reaches down through it, as it has no
// bottom face for a point: no way out takes the hull down.
static double satOverlap(const scBox_t *b, const scHull_t *h, const double a[3], bool standing, int *dir)
{
    double lo = INFINITY, hi = -INFINITY, c = 0, r = 0;
    for (int k = 0; k < SC_HULL_POINTS; k++) {
        const double s = vdot(h->v[k], a);
        lo = fmin(lo, s);
        hi = fmax(hi, s);
    }
    for (int k = 0; k < 3; k++) {
        c += (b->min[k] + b->max[k]) * 0.5 * a[k];
        r += (b->max[k] - b->min[k]) * 0.5 * fabs(a[k]);
    }
    const double up = standing && a[1] < 0 ? INFINITY : c + r - lo;        // moving the hull along a
    const double down = standing && a[1] > 0 ? INFINITY : hi - (c - r);    // and against it
    *dir = up <= down ? 1 : -1;
    return fmin(up, down);
}

// The separating-axis test of box b against hull h (the box's three axes, the
// hull's five faces, and each box axis across each of the hull's eight
// edges): 0 when an axis separates them to within FACE_EPS, otherwise the
// least overlap, with n the unit direction the hull leaves the box by.
static double hullDepth(const scBox_t *b, scHull_t *h, double n[3])
{
    hullFaces(h);
    const bool standing = grounded(b, floorZ * WS);     // the footprint's floor: no pad
    double best = INFINITY;
    for (int t = 0; t < 32; t++) {
        double a[3] = { 0, 0, 0 };
        if (t < 3) {
            a[t] = 1;
        } else if (t < 8) {
            memcpy(a, h->n[t - 3], sizeof(a));
        } else {
            const int *e = HULL_EDGES[(t - 8) % 8];
            const double ed[3] = { h->v[e[1]][0] - h->v[e[0]][0], h->v[e[1]][1] - h->v[e[0]][1],
                                   h->v[e[1]][2] - h->v[e[0]][2] };
            double u[3] = { 0, 0, 0 };
            u[(t - 8) / 8] = 1;
            vcross(u, ed, a);
            const double len = sqrt(vdot(a, a));
            if (!(len > 1e-9 * sqrt(vdot(ed, ed)))) {
                continue;                   // parallel: a face axis covers it
            }
            for (int k = 0; k < 3; k++) {
                a[k] /= len;
            }
        }
        int dir;
        const double o = satOverlap(b, h, a, standing, &dir);
        if (o <= FACE_EPS) {
            return 0;
        }
        if (o < best) {
            best = o;
            for (int k = 0; k < 3; k++) {
                n[k] = dir * a[k];
            }
        }
    }
    return best;
}

// The part of segment a-e (t0..t1) inside the hull, or false.
static bool clipHull(const scHull_t *h, const double a[3], const double e[3], double *t0, double *t1)
{
    for (int f = 0; f < 5; f++) {
        const double da = vdot(h->n[f], a) - h->d[f], de = vdot(h->n[f], e) - h->d[f];
        if (da > 0 && de > 0) {
            return false;
        }
        if (da > 0) {
            *t0 = fmax(*t0, da / (da - de));
        } else if (de > 0) {
            *t1 = fmin(*t1, da / (da - de));
        }
    }
    return *t0 <= *t1;
}

// The part of segment a-e (t0..t1) inside box b, or false.
static bool clipBox(const scBox_t *b, const double a[3], const double e[3], double *t0, double *t1)
{
    for (int k = 0; k < 3; k++) {
        const double dk = e[k] - a[k];
        if (dk == 0) {
            if (a[k] < b->min[k] || a[k] > b->max[k]) {
                return false;
            }
            continue;
        }
        const double u0 = (b->min[k] - a[k]) / dk, u1 = (b->max[k] - a[k]) / dk;
        *t0 = fmax(*t0, fmin(u0, u1));
        *t1 = fmin(*t1, fmax(u0, u1));
        if (*t0 > *t1) {
            return false;
        }
    }
    return true;
}

// Where the hull holds box b off: the box's edges clipped to the hull (the
// box feature inside it), or, when no edge of the box is in it (a hull edge
// through a box face), the hull's edges clipped to the box. Of the ends,
// the deepest (along n into the hull, or against it into the box) and the
// one farthest from it: a box edge across a hull face is held at both ends,
// a corner at the corner.
static int holdPoints(const scBox_t *b, const scHull_t *h, const double n[3], double out[2][3])
{
    double ends[24][3];
    int count = 0, pass = 0;
    for (; pass < 2 && !count; pass++) {
        for (int s = 0; s < (pass ? 8 : 12); s++) {
            double a[3], e[3], t0 = 0, t1 = 1;
            bool in;
            if (!pass) {
                const int k = s / 4, k1 = (k + 1) % 3, k2 = (k + 2) % 3;
                a[k] = b->min[k];
                e[k] = b->max[k];
                a[k1] = e[k1] = (s & 1) ? b->max[k1] : b->min[k1];
                a[k2] = e[k2] = (s & 2) ? b->max[k2] : b->min[k2];
                in = clipHull(h, a, e, &t0, &t1);
            } else {
                memcpy(a, h->v[HULL_EDGES[s][0]], sizeof(a));
                memcpy(e, h->v[HULL_EDGES[s][1]], sizeof(e));
                in = clipBox(b, a, e, &t0, &t1);
            }
            if (in) {
                for (int k = 0; k < 3; k++) {
                    ends[count][k] = a[k] + t0 * (e[k] - a[k]);
                    ends[count + 1][k] = a[k] + t1 * (e[k] - a[k]);
                }
                count += 2;
            }
        }
    }
    if (!count) {
        return 0;
    }
    const double into = pass == 1 ? 1 : -1;     // the pass that found them: 1 the box's, 2 the hull's
    int deep = 0, far = 0;
    for (int j = 1; j < count; j++) {
        if (into * vdot(ends[j], n) > into * vdot(ends[deep], n)) {
            deep = j;
        }
    }
    double farD = 0;
    for (int j = 0; j < count; j++) {
        const double d[3] = { ends[j][0] - ends[deep][0], ends[j][1] - ends[deep][1], ends[j][2] - ends[deep][2] };
        if (vdot(d, d) > farD) {
            farD = vdot(d, d);
            far = j;
        }
    }
    memcpy(out[0], ends[deep], sizeof(out[0]));
    memcpy(out[1], ends[far], sizeof(out[1]));
    return farD > PAST_WU * PAST_WU ? 2 : 1;
}

// Whether a footprint point (a corner of hull h) is strictly inside box b.
static bool pointIn(const scBox_t *b, const scHull_t *h)
{
    for (int k = 0; k < SC_HULL_POINTS; k++) {
        const double *v = h->v[k];
        if (v[0] > b->min[0] + FACE_EPS && v[0] < b->max[0] - FACE_EPS && v[1] > b->min[1] + FACE_EPS
            && v[1] < b->max[1] - FACE_EPS && v[2] > b->min[2] + FACE_EPS && v[2] < b->max[2] - FACE_EPS) {
            return true;
        }
    }
    return false;
}

int sc_world_hull(const double end[SC_HULL_POINTS][3], const double start[SC_HULL_POINTS][3],
                  sc_hull_contact_t *out, int max)
{
    if (!boxCount) {
        return 0;
    }
    if (solidsStale) {
        buildSolids();
    }
    scHull_t h, h0;
    bool start0 = false;
    hullAt(end, &h);
    int count = 0;
    for (int o = 0; o < solidCount; o++) {
        const int i = solidOrder[o];
        const scBox_t *b = &solids[i];
        bool apart = false;
        for (int k = 0; k < 3 && !apart; k++) {
            apart = h.hi[k] <= b->min[k] + FACE_EPS || h.lo[k] >= b->max[k] - FACE_EPS;
        }
        if (apart) {
            continue;
        }
        // A solid a footprint point is inside: the point resolves it.
        if (pointIn(b, &h)) {
            continue;
        }
        double n[3];
        const double depth = hullDepth(b, &h, n);
        if (!(depth > 0)) {
            continue;
        }
        // A solid the hull began the tick in at least as deep (a pose, or a
        // post through the quad's middle): not passing into it this tick. One
        // it began in less deep is pushed back only as far as it went deeper
        // this tick: all of a carried overlap at once (19 mm) threw the quad
        // into the next post, and that one threw it back. A solid a point
        // began the tick inside is left to that point (a thin wall through
        // the quad, held at its depth by the hull, kept a rim inside it).
        if (!start0) {
            hullAt(start, &h0);
            start0 = true;
        }
        double n0[3];
        const double depth0 = hullDepth(b, &h0, n0);
        if ((depth0 > 0 && depth <= depth0 + FACE_EPS) || pointIn(b, &h0)) {
            continue;
        }
        const double deeper = depth0 > 0 ? depth - depth0 : depth;
        double held[2][3];
        const int points = holdPoints(b, &h, n, held);
        if (!points) {
            continue;
        }
        // The deepest max; among equals, in order of position (the order of
        // the solids here), not the map's order. Compared as stored, so equal
        // depths are equal.
        int at = count;
        while (at > 0 && out[at - 1].depth < depth / WS) {
            at--;
        }
        if (at >= max) {
            continue;
        }
        for (int k = count < max ? count : max - 1; k > at; k--) {
            out[k] = out[k - 1];
        }
        if (count < max) {
            count++;
        }
        sc_hull_contact_t *hc = &out[at];
        for (int j = 0; j < 2; j++) {
            world2mod(held[j], hc->point[j]);
        }
        hc->points = points;
        hc->normal[0] = -n[2];
        hc->normal[1] = -n[0];
        hc->normal[2] = n[1];
        hc->depth = depth / WS;
        // Keyed by the box face the hull leaves by: the one most along n, on
        // the piece there.
        hc->ax = fabs(n[0]) >= fabs(n[1]) && fabs(n[0]) >= fabs(n[2]) ? 0 : fabs(n[1]) >= fabs(n[2]) ? 1 : 2;
        hc->side = n[hc->ax] > 0 ? 1 : -1;
        hc->box = pieceAt(i, hc->ax, hc->side, held[0]);
        // Pushed out along that face's axis, as a point is, as far as clears
        // the overlap along n (what it went deeper this tick).
        double push[3] = { 0, 0, 0 };
        push[hc->ax] = deeper / n[hc->ax];
        world2mod(push, hc->push);
    }
    return count;
}

uint32_t sc_world_hull_hit(const sc_hull_contact_t *c, double vel[3], double bounceScale, double crashScale,
                           double spinScale, bool *scrub, double normal[3])
{
    const scBox_t *b = &boxes[c->box];
    const double n[3] = { -c->normal[1], c->normal[2], -c->normal[0] };
    double cv[3];
    mod2world(vel, cv);
    const double vn = vdot(cv, n);
    const double into = fmax(0, -vn);
    const bool top = c->ax == 1 && c->side > 0;
    bool crashed = false;
    *scrub = false;
    memcpy(normal, c->normal, 3 * sizeof(double));
    if (top && into <= HARD_LANDING_WU) {
        // Resting on or landing softly on a box top's edge: as on the floor,
        // up (a tilted normal would walk the quad off the edge slowly).
        cv[1] = fmax(cv[1], 0);
        cv[0] *= 0.85;
        cv[2] *= 0.85;
        normal[0] = normal[1] = 0;
        normal[2] = 1;
        *scrub = true;
    } else {
        crashed = ductHit(cv, NULL, n, into, top, bounceScale, crashScale, spinScale);
    }
    touchFace(c->ax, c->side, c->side > 0 ? b->max[c->ax] : b->min[c->ax], b->id, into, crashed, true);
    world2mod(cv, vel);
    return 2;
}

bool sc_world_inside(const double pos[3])
{
    double cp[3];
    mod2world(pos, cp);
    return insideAnother(-1, cp);
}

void sc_world_after_points(const double com[3], bool floorHit)
{
    double cp[3];
    mod2world(com, cp);
    floorEdgeAndTriggers(cp, floorHit);
}
