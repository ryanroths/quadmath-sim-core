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
 *   - a tick that enters a trigger ends the tick run (sc_tick_stop), so the
 *     host's response lands on the next tick at any frame time
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <math.h>
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
static scBox_t triggers[SC_WORLD_TRIGGER_CAP];
static bool triggerInside[SC_WORLD_TRIGGER_CAP];
static int triggerCount;
static double floorZ;               // module-frame height of the ground plane, m
static bool onFloor;
// Faces touched recently, so a CONTACT event marks a new touch only.
typedef struct {
    int ax, side;
    double plane;
    uint64_t lastUs;
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

// Height above whatever is directly underneath: the floor, or the highest
// box top below the point (H:3206-3215, the same expression).
double sc_world_clearance_at(const double pos[3])
{
    double w[3];
    mod2world(pos, w);
    double top = (floorZ + FLOOR_PAD_M) * WS;
    for (int i = 0; i < boxCount; i++) {
        const scBox_t *b = &boxes[i];
        if (w[0] >= b->min[0] && w[0] <= b->max[0] && w[2] >= b->min[2] && w[2] <= b->max[2] && b->max[1] <= w[1]
            && b->max[1] > top) {
            top = b->max[1];
        }
    }
    return (w[1] - top) / WS;
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
    const double floorY = (floorZ + FLOOR_PAD_M) * WS;
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

// Whether a box is within PAST_WU of the point on every axis.
static bool nearBox(const scBox_t *b, const double w[3])
{
    return w[0] >= b->min[0] - PAST_WU && w[0] <= b->max[0] + PAST_WU && w[1] >= b->min[1] - PAST_WU
           && w[1] <= b->max[1] + PAST_WU && w[2] >= b->min[2] - PAST_WU && w[2] <= b->max[2] + PAST_WU;
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

// A touch of a box face: a CONTACT event unless the same face (axis, side,
// plane) was touched within CONTACT_GAP_US.
static void touchFace(int ax, int side, double plane, int id, double into, bool crashed)
{
    int oldest = 0;
    for (int k = 0; k < touchedCount; k++) {
        scFace_t *f = &touched[k];
        if (f->ax == ax && f->side == side && f->plane == plane) {
            if (sc_time_us - f->lastUs > CONTACT_GAP_US) {
                contactEvent(SC_EVENT_CONTACT, id, into, crashed);
            }
            f->lastUs = sc_time_us;
            return;
        }
        if (f->lastUs < touched[oldest].lastUs) {
            oldest = k;
        }
    }
    contactEvent(SC_EVENT_CONTACT, id, into, crashed);
    const scFace_t f = { ax, side, plane, sc_time_us };
    touched[touchedCount < CONTACT_FACES ? touchedCount++ : oldest] = f;
}

// After integration: floor, then the boxes (H:3150-3204, with the changes above).
// Returns contact flags: 1 floor, 2 box.
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
    const double floorY = (floorZ + FLOOR_PAD_M) * WS;
    uint32_t flags = 0;
    bool floorHit = false;
    if (cp[1] < floorY) {
        const double impact = -cv[1];
        cp[1] = floorY;
        floorHit = true;
        if (impact > HARD_LANDING_WU) {
            static const double up[3] = { 0, 1, 0 };
            const bool crashed = ductHit(cv, omega, up, impact, true, bounceScale, crashScale, spinScale);
            contactEvent(SC_EVENT_CONTACT, -1, impact, crashed);
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
        int bestRank = 3;
        bool anyNear = false;
        for (int i = 0; i < boxCount; i++) {
            const scBox_t *b = &boxes[i];
            // Within PAST_WU: a point nanometres off a slab that meets a wall
            // must still find the slab's top or bottom.
            if (!nearBox(b, cp)) {
                continue;
            }
            anyNear = true;
            // A box standing on the floor has no bottom face.
            const bool grounded = b->min[1] <= floorY + ON_FACE_WU;
            // Began the tick deep inside (a pose): leave through a surface.
            bool began = true;
            if (forceBegan) {
                began = nearBox(b, start);
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
            bool faceTop = false, faceInner = true;
            for (int ax = 0; ax < 3 && !outside; ax++) {
                for (int side = -1; side <= 1; side += 2) {
                    if (ax == 1 && side < 0 && grounded) {
                        continue;
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
                    bool inner = false;
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
                    }
                    // Top first, then surfaces before inner faces, then depth.
                    if ((top && !faceTop)
                        || (top == faceTop && ((!inner && faceInner) || (inner == faceInner && depth < faceDepth)))) {
                        faceAxis = ax;
                        faceSide = side;
                        faceDepth = depth;
                        faceTop = top;
                        faceInner = inner;
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
                touchFace(touchAxis, touchSide, plane, b->id, fmax(0, -touchSide * cv[touchAxis]), false);
                continue;
            }
            // Across boxes: an exposed top first, then a surface of a box the
            // tick did not begin inside, then the rest, then depth.
            const int faceRank = faceTop ? 0 : (!faceInner && !began) ? 1 : 2;
            if (faceSide != 0 && (faceRank < bestRank || (faceRank == bestRank && faceDepth < bestDepth))) {
                bestBox = i;
                bestAxis = faceAxis;
                bestSide = faceSide;
                bestDepth = faceDepth;
                bestRank = faceRank;
            }
        }
        if (pass == 0 && !forceBegan && anyNear && (bestBox < 0 || (bestRank == 2 && bestAxis == 1))
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
        touchFace(bestAxis, bestSide, plane, b->id, into, crashed);
    }
    world2mod(cp, pos);
    world2mod(cv, vel);
    if (scrub) {
        // Ground scrub: a tumble settles on contact (H:3196-3203).
        const double k = exp(-dt * TUMBLE_DECAY);
        omega[0] *= k;
        omega[1] *= k;
        omega[2] *= k;
    }
    if (floorHit) {
        flags |= 1;
    }
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
    return flags;
}
