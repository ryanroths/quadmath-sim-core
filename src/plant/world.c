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
 *     only the bottom face went), and is deep in it however near the floor
 *     (a rim lying on the floor, carried into the side by another point's
 *     push, was within ON_FACE_WU of the bottom plane, so not deep in the
 *     box, and no deeper than its travel, so out of reach: wedged in a gap
 *     it went 8.8 mm in). These rules and the next two are the footprint's:
 *     quadmath's CG point (the parity model's sc_world_contact) resolves
 *     boxes as it did, bit for bit (plant-world 39; P2 has no boxes and P5
 *     is the clearance query, so the gate cannot see it)
 *   - an inner face the point crossed this tick where the solid already was
 *     (where its path met the plane, other boxes all round it), or off the
 *     face in the open (no box just inside the plane there), ranks after the
 *     other inner faces: the point came in elsewhere, so that face is no way
 *     out. A rim deeper into a concave corner than past a split post's seam
 *     saw only the upper piece, all its faces inner, and the seam, the
 *     shallowest, held it at the split: an invisible ledge (crossing the
 *     split before either wall, 29 of 30 seeded hits; within PAST_WU of the
 *     wall plane one still can be)
 *   - an inner face is one the point came in through only if it travelled
 *     that deep into it this tick, and not if it met the face's plane in the
 *     open: the ON_FACE_WU allowance is for a point on a surface, not for a
 *     seam beside it. A rim pressed into a split wall as it rose into the
 *     ceiling beside the seam, 20 to 90 um from it and not moving across it,
 *     was pushed onto the seam, a touch whose friction cut its speed into
 *     the ceiling from 2.45 to 2.01 m/s; one that crossed the seam plane
 *     short of the wall, 45 um deep after 50 um of travel across it, was
 *     shoved onto the seam the same way (2.45 m/s into the ceiling, not a
 *     crash, against 2.99 m/s and a crash with the wall in one piece)
 *   - the footprint's hull (plant.c): a box edge or corner that ends a tick
 *     inside the convex hull of the five points (a square pyramid, the rims
 *     round the base, the canopy at the apex), with no point inside the box,
 *     is held off. The separating axis of least overlap finds how far; the
 *     push is along the axis of the box face most along it, as a point's
 *     is, and the box feature inside the hull (a corner, both ends of an
 *     edge across a face: one point there rocked the quad; or the corners
 *     of a box top between the rims: on a diagonal of a beam's top the quad
 *     rocked at up to 0.9 rad/s with its motors off and crept along it) is
 *     one to four contacts with a box hit's response, keyed by that face; a
 *     soft one on a box top is along the vertical, as on the floor (along
 *     the hull's tilted face it walked a quad resting on a table edge
 *     sideways).
 *     A box the hull began the tick in at least as deep (a pose, a post
 *     through the quad's middle) is not one it is passing into; one it began
 *     in less deep is pushed back only as far as it went deeper this tick
 *     (pushed out whole, a carried 19 mm overlap threw the quad into the
 *     next post, and that one threw it back: 20 to 40 mm one-tick pushes),
 *     and one a footprint point is inside at the start or end of the tick
 *     is left to that point only if the point's way out (its face of least
 *     penetration, no bottom face on a box standing on the floor) is along
 *     the hull's separating axis, so that resolving the point answers the
 *     overlap (held at its depth, a thin wall through the quad kept a rim
 *     9.9 mm inside it; left whole to the point, rims pinched 0 to 0.27 mm
 *     into a 68.6 mm post's sides let it 27 mm into the hull, and a rim
 *     pinched 0.2 to 0.7 mm into a slab's underside let its edge 38.6 mm
 *     in). Pressed up under a shelf shallower than the quad against a
 *     wall, the shelf's front edge passed between the leading rim and the
 *     rest and the quad swung over it onto the shelf (12 mm of edge inside
 *     the hull); set down level with its CG 10 mm behind a table edge, it
 *     tipped over the edge with the edge 9 mm into its body.
 *     Up to plant.c's HULL_BOXES (4) solids a tick are held, the deepest;
 *     with more, the one left out is the shallowest whose push face (axis
 *     and side) a deeper kept one has too, or failing that the shallowest,
 *     so a box top's corners never crowd a post's side out. With the
 *     deepest two kept, a post hit sliding in while landing on beams
 *     between the rims got no push, response or event that tick (held
 *     1.5 mm in the hull for two ticks, its crash lost), and a quad hung on
 *     the edges of three solids in a notch dropped a different one every
 *     tick and rocked for good with its motors off.
 *     Cost: each box top held between the rims is up to four contacts
 *     (holdPoints, SC_HULL_HOLD), each one more row in plant.c's 32 sweeps:
 *     at rest on two beams between the rims a tick is about 2.1 times the
 *     floor-rest tick (32 against 15 us on the reference machine). A tick
 *     with a hull contact also walks the solids in sc_world_hull and in
 *     drivesIn (per axis tried) and every box in plant.c's second resolution
 *     of the points: at rest on a table edge about 30 ns a box in the map,
 *     against 10 on the floor. The solids are in order of min x, so both
 *     walks stop at the first one past the hull (output the same)
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
 *   - the hull's push takes no footprint point into the solid: it is along
 *     the box face axis most along the separating axis, or failing that the
 *     next most along it, any at least a quarter along it (a push at most
 *     four times what it went deeper), whose push, swept, takes no point
 *     under the floor or into a solid it was not in; with none there is no
 *     push, and the contact's response holds the quad, only stopping it
 *     moving into the box (holding the speed it was leaving at, as a point's
 *     response does, fought the rims on the far side of a thin wall posed
 *     through the quad and wound it up to the spin cap), with what it went
 *     deeper (gain) as speed out in plant.c's sweeps. plant.c tops up a
 *     push another contact's left short, then resolves the five points again
 *     from where the points' push left them. Mostly vertical on the
 *     pyramid's sloped sides, the push drove a quad flying into a slot lower
 *     than the hull down into the table under it (rims through a 3 mm plate
 *     in one tick) or the floor, and wedged between boxes closer together
 *     than the footprint it pushed a rim back into the box the points had
 *     just left, every tick (5 to 21 mm deep). With no push allowed and only
 *     the motion stopped, the overlap each tick gained stayed: wedged on a
 *     bench plank's end beside a leg (a 42.8 mm slot) the plank went 26 mm
 *     into the hull, between two rims, no point ever in a box
 *   - a tick that enters a trigger ends the tick run (sc_tick_stop), so the
 *     host's response lands on the next tick at any frame time
 *   - walls (owner decision 2026-10-28, the physical model only): a box's
 *     vertical face answers a footprint point, or a duct's side point
 *     (plant.c: each rim's point furthest toward a face, met only by faces
 *     with that normal, among the boxes sc_world_near found near the quad),
 *     with the airframe's wall restitution along its normal and nothing
 *     taken along it here; plant.c's sweeps give it Coulomb friction. In
 *     sim.html every tick against a wall kept 0.82 of the speed along it
 *     (0.55 on a crash), which stopped a quad pressed on a wall in a few
 *     ticks. The floor, box tops and undersides, quadmath's CG point and the
 *     hull's contacts answer as before
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
#define SIDE_CREEP_WU (1e-3 * WS)   // 1 mm: a duct's side point's overlap from before the tick, moved out a tick

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

// The boxes near the quad this tick (sc_world_near), in order of position:
// the only boxes a duct's side point (sc_world_point with nearOnly) is
// resolved against.
static int nearList[SC_WORLD_BOX_CAP];
static int nearCount;
static int nearSolids[SC_WORLD_BOX_CAP];  // the solids those pieces make up, in order of position
static int nearSolidCount;

// The solids the boxes make up (buildSolids, below).
static scBox_t solids[SC_WORLD_BOX_CAP];
static int solidOf[SC_WORLD_BOX_CAP];

// A face (axis, outward side) as a bit of a face mask.
#define FACE_BIT(ax, side) (1 << ((ax) * 2 + ((side) > 0)))
#define ALL_FACES SC_WORLD_ALL_FACES

// How much deeper than it came in this tick a duct's side point is pushed out
// of a wall at most (world units).
static double sideReachWU;

void sc_world_set_side_reach(double metres)
{
    sideReachWU = metres * WS;
}

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

// A wall (a box's vertical face) and a footprint point or a duct's side
// (owner decision 2026-10-28): the speed into the face comes back at rest
// times itself, and the speed along it is left alone here: plant.c's sweeps
// take friction off it, at most the airframe's wall friction times the push.
// The crash threshold is quadmath's, for the CONTACT event only.
static bool wallBounce(double vel[3], const double n[3], double into, double rest, double crashScale)
{
    const double vn = vdot(vel, n);
    const double leave = vn < 0 ? vn : -into;
    for (int k = 0; k < 3; k++) {
        vel[k] += n[k] * (-(1 + rest) * leave);
    }
    return into > CRASH_SPEED_WU * crashScale;
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

// While a duct's side point is resolved, the boxes sc_world_near found are the
// only ones its samples can be in (they lie within PAST_WU of a point in the
// near region): walking every box in the map for each face of each point
// doubled the tick of a quad resting on a table in a map of a thousand boxes.
static bool nearWalk;

// Whether a box other than skip has the point strictly inside it.
static bool insideAnother(int skip, const double p[3])
{
    const int walk = nearWalk ? nearCount : boxCount;
    for (int at = 0; at < walk; at++) {
        const int j = nearWalk ? nearList[at] : at;
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
// side) this tick where that face is no way in: where its path from start to
// end crossed the plane, four points PAST_WU outside the face, offset
// diagonally along it, are all inside other boxes (it crossed inside the
// solid: a split post's seam crossed in a concave corner), or the four PAST_WU
// inside the plane are inside no box, this one included (it crossed off the
// face, in the open, before it reached the solid). Either way it came in
// somewhere else, so the face is not its way back out.
static bool crossedInside(int skip, const double start[3], const double end[3], int ax, int side, double plane)
{
    if (side > 0 ? !(start[ax] >= plane && end[ax] < plane) : !(start[ax] <= plane && end[ax] > plane)) {
        return false;                   // not crossed on the way in this tick
    }
    const double f = (plane - start[ax]) / (end[ax] - start[ax]);
    const int t0 = (ax + 1) % 3, t1 = (ax + 2) % 3;
    bool inside = true, open = true;
    for (int s0 = -1; s0 <= 1; s0 += 2) {
        for (int s1 = -1; s1 <= 1; s1 += 2) {
            double q[3];
            q[ax] = plane + side * PAST_WU;
            q[t0] = start[t0] + f * (end[t0] - start[t0]) + s0 * PAST_WU;
            q[t1] = start[t1] + f * (end[t1] - start[t1]) + s1 * PAST_WU;
            inside = inside && insideAnother(skip, q);
            q[ax] = plane - side * PAST_WU;
            open = open && !insideAnother(-1, q);
        }
    }
    return inside || open;
}

// Whether the point met the plane of an inner face (axis ax, outward side)
// this tick in the open: just inside the plane where its path from start to
// end met it (the ends clamped, for a start up to FACE_EPS inside the plane)
// is inside no box. It came into the solid elsewhere, so it did not come in
// through that face: a rim crossing a split wall's seam plane short of the
// wall, under the ceiling, was shoved onto the seam.
static bool crossedInOpen(const double start[3], const double end[3], int ax, int side, double plane)
{
    if (end[ax] == start[ax]) {
        return false;
    }
    const double f = fmin(1, fmax(0, (plane - start[ax]) / (end[ax] - start[ax])));
    double q[3];
    for (int a = 0; a < 3; a++) {
        q[a] = start[a] + f * (end[a] - start[a]);
    }
    q[ax] = plane - side * PAST_WU;
    for (int j = 0; j < boxCount; j++) {
        if (contains(&boxes[j], q)) {
            return false;
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
// faceMask: the faces (FACE_BIT) the point may be pushed out through or
// touch; a point is still outside a box past any of its faces. The floor
// counts only with box tops in the mask. nearOnly: only the boxes
// sc_world_near found. wallRest (a footprint point or a duct's side, not
// quadmath's CG point): at or above 0, a vertical face answers with
// wallBounce at that restitution instead of ductHit; *wallOut says the
// point's only response was that.
static uint32_t resolvePoint(double cp[3], double cv[3], const double start[3], double dt, double bounceScale,
                             double crashScale, double spinScale, double omega[3], bool pad, int faceMask,
                             bool nearOnly, double wallRest, bool *floorHitOut, bool *scrubOut, bool *wallOut)
{
    const double floorY = (floorZ + (pad ? FLOOR_PAD_M : 0)) * WS;
    uint32_t flags = 0;
    bool floorHit = false, wallHit = false, otherHit = false;
    if (cp[1] < floorY && (faceMask & FACE_BIT(1, 1))) {
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
    // A duct's side point under the floor (the floor meets only the rims, so
    // a tilted duct's side dips under it) meets boxes where the floor is: 20
    // um under it, out of a standing box's reach down to the floor, one
    // pressed into the foot of the box's side 1.6 mm. Only the box's push
    // moves it; the lift is taken off again.
    nearWalk = nearOnly;
    const double sunkY = cp[1];
    const bool sunk = (faceMask & ALL_FACES) != ALL_FACES && cp[1] < floorY;
    if (sunk) {
        cp[1] = floorY;
    }
    // Where the tick integrated the point to (after the floor): travel into a
    // face is measured to here, not to where an earlier pass pushed it.
    const double tickPos[3] = { cp[0], cp[1], cp[2] };
    // A pose deep in the solid where no box sees a way out (on a seam plane):
    // pass 0 is run again treating every nearby box as one the tick began in.
    bool forceBegan = false;
    for (int pass = 0; pass < BOX_PASSES; pass++) {
        int bestBox = -1, bestAxis = 0, bestSide = 0;
        double bestDepth = INFINITY, bestReach = INFINITY;
        int bestRank = 4;
        bool anyNear = false;
        const int walk = nearOnly ? nearCount : boxCount;
        for (int at = 0; at < walk; at++) {
            const int i = nearOnly ? nearList[at] : at;
            const scBox_t *b = &boxes[i];
            // Within PAST_WU: a point nanometres off a slab that meets a wall
            // must still find the slab's top or bottom.
            if (!nearBox(b, cp, floorY, !pad)) {
                continue;
            }
            anyNear = true;
            const bool onFloor = grounded(b, floorY);
            if ((faceMask & ALL_FACES) != ALL_FACES) {
                // A duct's side point (its face kinds in faceMask): the box's
                // surface of least penetration, if that is one of its face
                // kinds and no deeper than sideReachWU. Seams (inner faces, a
                // hair past one included: a 1 um gap let one through) and a
                // standing box's bottom are not surfaces; tops and undersides
                // are, and are the rims' and the canopy's. Sunk under a box
                // top as the quad lands on it, the top is the shallowest: met
                // as a wall instead, a split table's seam stopped a 5 m/s
                // slide in 0.1 m, and leaving through the nearest side shoved
                // a quad resting tilted on a table a metre. Past a stack's
                // seam the face goes on (the top under the next crate is a
                // seam). Deeper than it came in this tick by more than
                // sideReachWU (the band round a duct the rims do not cover) is
                // the footprint's, a pose's overlap: deep in two overlapping
                // boxes, their near faces seams, a far end was the nearest
                // surface and shoved the quad 5 m, and a pose across a gym
                // seam was shoved 26 mm in a tick. Answered
                // only through faces it came in through this tick, a side point
                // that got into a wall any other way (through a box top as the
                // quad came down past its edge, carried by another push, a
                // corner's leftover) was never pushed out, and the duct sank
                // 5 to 15 mm in. An edge point (SC_WORLD_EDGE_FLAG) leaves
                // through its one face, chosen to clear the corner; the edge's
                // other face is not weighed against it.
                const bool edge = (faceMask & SC_WORLD_EDGE_FLAG) != 0;
                int leastAx = -1, leastSide = 0;
                double least = INFINITY;
                bool out = false;
                for (int ax = 0; ax < 3 && !out; ax++) {
                    for (int side = -1; side <= 1; side += 2) {
                        if (ax == 1 && side < 0 && onFloor) {
                            continue;
                        }
                        const double plane = side > 0 ? b->max[ax] : b->min[ax];
                        const double depth = side > 0 ? plane - cp[ax] : cp[ax] - plane;
                        if (depth <= FACE_EPS && covered(i, cp, ax, side, plane)) {
                            continue;
                        }
                        // An edge point lies on the edge's other face (plant.c
                        // takes it where the rim crosses that face): rebuilt
                        // from the body frame it can land 1e-17 off it, and
                        // marked outside the box, a duct went 4.5 mm into a
                        // post's corner unanswered.
                        const bool ignored = edge && ax != 1 && !(faceMask & FACE_BIT(ax, side));
                        if (depth < (ignored ? -FACE_EPS : 0)) {
                            out = true;
                            break;
                        }
                        if (ignored) {
                            continue;
                        }
                        if (depth < least && !covered(i, cp, ax, side, plane)) {
                            least = depth;
                            leastAx = ax;
                            leastSide = side;
                        }
                    }
                }
                if (out || leastAx < 0 || !(faceMask & FACE_BIT(leastAx, leastSide))) {
                    continue;
                }
                const double travel = leastSide > 0 ? start[leastAx] - tickPos[leastAx] : tickPos[leastAx] - start[leastAx];
                if (least > fmax(0, travel) + sideReachWU) {
                    continue;
                }
                double came = travel;
                // Come in this tick through the box's other side face (a
                // corner: in through one face, out through the other): the
                // overlap is all this tick's and goes out whole, up to that
                // face's travel (the point is admitted as before). A rim
                // past a post's y face beside it, swung in through its x face
                // 2.8 mm, crept out 1 mm and ended the tick 0.6 mm in. Only
                // through that face itself: not across a seam's plane, nor its
                // plane off the face (a point come down through a split
                // table's top, or out of a 1 um gap, was pushed out whole where
                // one piece crept). And only out through the nearer of the
                // solid's two faces on the way out: a duct come in at a 10 mm
                // post's near corner was pushed out through its far face, the
                // wrong way, 8.7 mm. An edge point lies on its edge's other
                // face (plant.c takes it where the rim crosses it), so in as
                // far as the plane counts.
                const scBox_t *sol = &solids[solidOf[i]];
                if (2 * least <= sol->max[leastAx] - sol->min[leastAx]) {
                    for (int ax2 = 0; ax2 < 3; ax2 += 2) {
                        for (int side2 = -1; side2 <= 1 && ax2 != leastAx; side2 += 2) {
                            const double plane2 = side2 > 0 ? b->max[ax2] : b->min[ax2];
                            const double was = side2 > 0 ? plane2 - start[ax2] : start[ax2] - plane2;
                            const double now = side2 > 0 ? plane2 - tickPos[ax2] : tickPos[ax2] - plane2;
                            if (!(was < 0 && now >= -FACE_EPS)) {
                                continue;
                            }
                            double end[3] = { tickPos[0], tickPos[1], tickPos[2] };
                            end[ax2] = plane2 - side2 * fmax(now, 2 * FACE_EPS);
                            if (!crossedInside(i, start, end, ax2, side2, plane2)) {
                                came = fmax(came, now - was);
                            }
                        }
                    }
                }
                // What came in this tick goes out whole (a hit); an overlap
                // from before it (a pose's, a corner's leftover, a duct come
                // in through a box top) creeps out SIDE_CREEP_WU a tick, as
                // the hull's carried overlaps do: a pose across a gym seam
                // was otherwise pushed 9.6 mm in a tick.
                // A budget over the passes of this call: less what earlier
                // passes moved the point out along the face (a point between
                // two faces was moved 1 mm by each, 2 mm a tick).
                const double already = fmax(0, leastSide * (cp[leastAx] - tickPos[leastAx]));
                const double reachOut = fmax(0, came) + ON_FACE_WU + SIDE_CREEP_WU - already;
                if (!(reachOut > 0)) {
                    continue;
                }
                if (least <= FACE_EPS) {
                    flags |= 2;
                    const double plane = leastSide > 0 ? b->max[leastAx] : b->min[leastAx];
                    touchFace(leastAx, leastSide, plane, b->id, fmax(0, -leastSide * cv[leastAx]), false, true);
                    continue;
                }
                if (bestRank > 1 || least < bestDepth) {
                    bestBox = i;
                    bestAxis = leastAx;
                    bestSide = leastSide;
                    bestDepth = least;
                    bestReach = reachOut;
                    bestRank = 1;
                }
                continue;
            }
            // Began the tick deep inside (a pose): leave through a surface.
            // For a footprint point a box standing on the floor has no
            // bottom surface to be near: a rim on the floor, carried into
            // the box's side by another point's push, is deep in it.
            bool began = true;
            if (forceBegan) {
                began = nearBox(b, start, floorY, !pad);
            } else {
                for (int a = 0; a < 3 && began; a++) {
                    began = (start[a] > b->min[a] + ON_FACE_WU || (a == 1 && !pad && onFloor))
                            && start[a] < b->max[a] - ON_FACE_WU;
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
                        if (touchAxis < 0 && (faceMask & FACE_BIT(ax, side))) {
                            touchAxis = ax;     // lying on its surface: touching
                            touchSide = side;
                        }
                        continue;
                    }
                    if (!(faceMask & FACE_BIT(ax, side))) {
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
                        if (!pad && inner
                            && (depth > fmax(0, travel) + FACE_EPS || crossedInOpen(start, tickPos, ax, side, plane))) {
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
        if (pass == 0 && !forceBegan && (faceMask & ALL_FACES) == ALL_FACES && anyNear
            && (bestBox < 0 || (bestRank >= 2 && bestAxis == 1)) && deepInSolid(start)) {
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
        if (bestDepth > bestReach) {
            cp[bestAxis] += bestSide * bestReach;     // a duct's side: the overlap from before the tick creeps out
        } else {
            cp[bestAxis] = plane;
        }
        const double into = fmax(0, -bestSide * cv[bestAxis]);
        const bool top = bestAxis == 1 && bestSide > 0;
        bool crashed = false;
        if (top && into <= HARD_LANDING_WU) {
            // Resting on or landing softly on a box top: as on the floor.
            cv[1] = fmax(cv[1], 0);
            cv[0] *= 0.85;
            cv[2] *= 0.85;
            scrub = true;
            otherHit = true;
        } else if (!pad && wallRest >= 0 && bestAxis != 1) {
            crashed = wallBounce(cv, n, into, wallRest, crashScale);
            wallHit = true;
        } else {
            crashed = ductHit(cv, omega, n, into, top, bounceScale, crashScale, spinScale);
            otherHit = true;
        }
        touchFace(bestAxis, bestSide, plane, b->id, into, crashed, !pad);
    }
    if (floorHit) {
        flags |= 1;
    }
    if (sunk) {
        cp[1] = sunkY;
    }
    nearWalk = false;
    *floorHitOut = floorHit;
    *scrubOut = scrub;
    if (wallOut) {
        *wallOut = wallHit && !otherHit && !floorHit;
    }
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
    const uint32_t flags = resolvePoint(cp, cv, start, dt, bounceScale, crashScale, spinScale, omega, true, ALL_FACES,
                                        false, -1, &floorHit, &scrub, NULL);
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

// A box face's outward normal in the module frame, as a face mask bit: world
// (x, y, z) = (-y, z, -x) of it.
int sc_world_face_bit(const double n[3])
{
    const double w[3] = { -n[1], n[2], -n[0] };
    int ax = 0;
    for (int a = 1; a < 3; a++) {
        if (fabs(w[a]) > fabs(w[ax])) {
            ax = a;
        }
    }
    return FACE_BIT(ax, w[ax] > 0 ? 1 : -1);
}

uint32_t sc_world_point(double pos[3], double vel[3], const double startPos[3], double dt, double bounceScale,
                        double crashScale, double spinScale, int faceMask, double wallRest, bool *floorHit,
                        bool *scrub, bool *wall)
{
    double cp[3], cv[3], start[3];
    mod2world(pos, cp);
    mod2world(vel, cv);
    mod2world(startPos, start);
    const double cp0[3] = { cp[0], cp[1], cp[2] }, cv0[3] = { cv[0], cv[1], cv[2] };
    const uint32_t flags = resolvePoint(cp, cv, start, dt, bounceScale, crashScale, spinScale, NULL, false, faceMask,
                                        (faceMask & ALL_FACES) != ALL_FACES, wallRest, floorHit, scrub, wall);
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
// solids: indexed by the solid's first box, extents only; solidOf: the solid a
// box is part of (declared above).
static int solidFirst[SC_WORLD_BOX_CAP];   // a solid's first piece; pieceNext links the rest
static int pieceNext[SC_WORLD_BOX_CAP];
static int solidOrder[SC_WORLD_BOX_CAP];   // the solids, in order of position
static double solidMaxX[SC_WORLD_BOX_CAP]; // the greatest max x of the solids up to each in that order
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
    for (int o = 0; o < solidCount; o++) {
        const double x = solids[solidOrder[o]].max[0];
        solidMaxX[o] = o && solidMaxX[o - 1] > x ? solidMaxX[o - 1] : x;
    }
    qsort(pieceOrder, boxCount, sizeof(int), piecesByPosition);
    for (int k = boxCount - 1; k >= 0; k--) {
        const int j = pieceOrder[k];
        pieceNext[j] = solidFirst[solidOf[j]];
        solidFirst[solidOf[j]] = j;
    }
    solidsStale = false;
}

// The boxes within reach of a module-frame region (the quad's span over the
// tick), for the ducts' side points. The solids are in order of min x: the
// walk starts at the first whose max x, or an earlier one's, reaches the
// region (a binary search on the running greatest max x) and stops at the
// first that starts past it, so a tick away from every box costs a few
// comparisons, not a pass over the map.
int sc_world_near(const double lo[3], const double hi[3])
{
    nearCount = 0;
    nearSolidCount = 0;
    if (!boxCount) {
        return 0;
    }
    if (solidsStale) {
        buildSolids();
    }
    double a[3], b[3], wlo[3], whi[3];
    mod2world(lo, a);
    mod2world(hi, b);
    for (int k = 0; k < 3; k++) {
        wlo[k] = fmin(a[k], b[k]) - PAST_WU - ON_FACE_WU;
        whi[k] = fmax(a[k], b[k]) + PAST_WU + ON_FACE_WU;
    }
    int first = 0, last = solidCount;
    while (first < last) {
        const int mid = first + (last - first) / 2;
        if (solidMaxX[mid] < wlo[0]) {
            first = mid + 1;
        } else {
            last = mid;
        }
    }
    for (int o = first; o < solidCount; o++) {
        const scBox_t *s = &solids[solidOrder[o]];
        if (s->min[0] > whi[0]) {
            break;                      // in order of min x: this and the rest start past the region
        }
        if (s->max[0] < wlo[0] || s->min[1] > whi[1] || s->max[1] < wlo[1] || s->min[2] > whi[2]
            || s->max[2] < wlo[2]) {
            continue;
        }
        nearSolids[nearSolidCount++] = solidOrder[o];
        for (int j = solidFirst[solidOrder[o]]; j >= 0; j = pieceNext[j]) {
            const scBox_t *p = &boxes[j];
            if (p->min[0] <= whi[0] && p->max[0] >= wlo[0] && p->min[1] <= whi[1] && p->max[1] >= wlo[1]
                && p->min[2] <= whi[2] && p->max[2] >= wlo[2]) {
                nearList[nearCount++] = j;
            }
        }
    }
    return nearCount;
}

// The vertical edges of the boxes sc_world_near found, in its order (module
// frame: x, y, bottom z, top z, the outward normals of the two faces meeting
// there, along x and along y, +-1, and the box's size across each of those
// faces), each with the mask of those two
// faces: those that reach between zlo and zhi, within reach of centre across
// the floor (taking a slot, the tiles of a floor under the rims pushed a
// post's corners past the cap); up to max (at most SC_WORLD_EDGE_CAP).
static int edgeBox[SC_WORLD_EDGE_CAP];
static int edgeSides[SC_WORLD_EDGE_CAP][2];

int sc_world_near_edges(const double centre[3], double reach, double zlo, double zhi, double edges[][8], int masks[],
                        int max)
{
    int n = 0;
    if (max > SC_WORLD_EDGE_CAP) {
        max = SC_WORLD_EDGE_CAP;
    }
    for (int at = 0; at < nearCount && n < max; at++) {
        const scBox_t *b = &boxes[nearList[at]];
        if (b->max[1] / WS < zlo || b->min[1] / WS > zhi) {
            continue;
        }
        const scBox_t *sol = &solids[solidOf[nearList[at]]];
        for (int c = 0; c < 4 && n < max; c++) {
            const int sx = c & 1 ? 1 : -1, sz = c & 2 ? 1 : -1;     // world x and z sides
            const double wx = sx > 0 ? b->max[0] : b->min[0];
            const double wz = sz > 0 ? b->max[2] : b->min[2];
            // A piece's corner that is not its solid's has a face inside the
            // solid, a seam all along it: never a corner (a floor in tiles
            // filled the slots and a post's corner lost its edge points).
            if (wx != (sx > 0 ? sol->max[0] : sol->min[0]) || wz != (sz > 0 ? sol->max[2] : sol->min[2])) {
                continue;
            }
            if (!(hypot(-wz / WS - centre[0], -wx / WS - centre[1]) <= reach)) {
                continue;
            }
            edges[n][0] = -wz / WS;
            edges[n][1] = -wx / WS;
            edges[n][2] = b->min[1] / WS;
            edges[n][3] = b->max[1] / WS;
            edges[n][4] = -sz;
            edges[n][5] = -sx;
            edges[n][6] = (b->max[2] - b->min[2]) / WS;     // the box's size across the x face
            edges[n][7] = (b->max[0] - b->min[0]) / WS;     // and across the y face
            masks[n] = FACE_BIT(0, sx) | FACE_BIT(2, sz);
            edgeBox[n] = nearList[at];
            edgeSides[n][0] = sx;
            edgeSides[n][1] = sz;
            n++;
        }
    }
    return n;
}

// The tops (+1) and bottoms (-1) of the solids sc_world_near found, between
// zlo and zhi (module-frame heights), each height and kind once, in order of
// height (then kind); up to max. Solids, not pieces: a shelf cut along its
// height had its pieces' top and bottom at the cut, inside it, and points
// there the shelf in one piece did not have.
int sc_world_near_levels(double zlo, double zhi, double levels[], int kinds[], int max)
{
    int n = 0;
    for (int at = 0; at < nearSolidCount; at++) {
        const scBox_t *b = &solids[nearSolids[at]];
        for (int k = -1; k <= 1; k += 2) {
            const double z = (k > 0 ? b->max[1] : b->min[1]) / WS;
            if (z < zlo || z > zhi) {
                continue;
            }
            int j = 0;
            while (j < n && (levels[j] < z || (levels[j] == z && kinds[j] < k))) {
                j++;
            }
            if ((j < n && levels[j] == z && kinds[j] == k) || j == max) {
                continue;               // already there, or past the last kept
            }
            for (int m = (n < max ? n : max - 1); m > j; m--) {
                levels[m] = levels[m - 1];
                kinds[m] = kinds[m - 1];
            }
            levels[j] = z;
            kinds[j] = k;
            if (n < max) {
                n++;
            }
        }
    }
    return n;
}

// Whether edge e (of the last sc_world_near_edges) is a corner of the solid
// at a module-frame point by it: neither of its faces is a seam there (the
// edges of a wall in pieces, along their seam, are inside the wall).
bool sc_world_edge_open(int e, const double at[3])
{
    double cp[3];
    mod2world(at, cp);
    const scBox_t *b = &boxes[edgeBox[e]];
    const int sides[2][2] = { { 0, edgeSides[e][0] }, { 2, edgeSides[e][1] } };
    for (int f = 0; f < 2; f++) {
        const int ax = sides[f][0], side = sides[f][1];
        if (covered(edgeBox[e], cp, ax, side, side > 0 ? b->max[ax] : b->min[ax])) {
            return false;
        }
    }
    return true;
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
// the deepest (along n into the hull, or against it into the box), the one
// farthest from it, and, more than PAST_WU off the line between them (seen
// along n), the farthest on each side: a box edge across a hull face is held
// at both ends, a corner at the corner, and a box top between the rims (a
// beam, a post) at its corners in the hull. On a diagonal of the beam's top
// the quad tipped about it and the support flipped between diagonals: it
// rocked at up to 0.9 rad/s with the motors off and crept along the beam.
static int holdPoints(const scBox_t *b, const scHull_t *h, const double n[3], double out[SC_HULL_HOLD][3])
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
    if (!(farD > PAST_WU * PAST_WU)) {
        return 1;
    }
    memcpy(out[1], ends[far], sizeof(out[1]));
    // Off the line deep-far: (l x d) . n is |l| times the offset seen along n.
    const double l[3] = { ends[far][0] - ends[deep][0], ends[far][1] - ends[deep][1], ends[far][2] - ends[deep][2] };
    int side[2] = { -1, -1 };
    double sideD[2] = { PAST_WU * sqrt(farD), PAST_WU * sqrt(farD) };
    for (int j = 0; j < count; j++) {
        const double d[3] = { ends[j][0] - ends[deep][0], ends[j][1] - ends[deep][1], ends[j][2] - ends[deep][2] };
        double c[3];
        vcross(l, d, c);
        const double s = vdot(c, n);
        const int k = s > 0 ? 0 : 1;
        if (fabs(s) > sideD[k]) {
            sideD[k] = fabs(s);
            side[k] = j;
        }
    }
    int points = 2;
    for (int k = 0; k < 2; k++) {
        if (side[k] >= 0) {
            memcpy(out[points++], ends[side[k]], sizeof(out[0]));
        }
    }
    return points;
}

// Whether moving hull h by d along axis ax (world units) takes a footprint
// point under the floor, or into a solid it was not inside, on the way: the
// move is swept (at 6 m/s a 4.6 mm push carried rims right through a 3 mm
// plate and out of it).
static bool drivesIn(const scHull_t *h, int ax, double d)
{
    if (ax == 1 && d < 0 && h->lo[1] + d < floorZ * WS - FACE_EPS) {
        return true;
    }
    for (int o = 0; o < solidCount; o++) {
        const scBox_t *b = &solids[solidOrder[o]];
        if (h->hi[0] + (ax == 0 ? fmax(d, 0) : 0) <= b->min[0] + FACE_EPS) {
            break;                      // in order of min x: this and the rest start past the swept hull
        }
        bool clear = false;             // the hull's bounds, swept, clear of it
        for (int a = 0; a < 3 && !clear; a++) {
            const double lo = h->lo[a] + (a == ax ? fmin(d, 0) : 0), hi = h->hi[a] + (a == ax ? fmax(d, 0) : 0);
            clear = hi <= b->min[a] + FACE_EPS || lo >= b->max[a] - FACE_EPS;
        }
        for (int k = 0; k < SC_HULL_POINTS && !clear; k++) {
            const double *v = h->v[k];
            const double lo = fmin(v[ax], v[ax] + d), hi = fmax(v[ax], v[ax] + d);
            bool across = lo < b->max[ax] - FACE_EPS && hi > b->min[ax] + FACE_EPS, was = true;
            for (int a = 0; a < 3; a++) {
                const bool in = v[a] > b->min[a] + FACE_EPS && v[a] < b->max[a] - FACE_EPS;
                across = across && (a == ax || in);
                was = was && in;
            }
            if (across && !was) {
                return true;
            }
        }
    }
    return false;
}

// Whether a footprint point (a corner of hull h) is strictly inside box b
// with its way out (the face of least penetration; a box standing on the
// floor has no bottom face) along the hull's separating axis n, either way:
// that point's resolution answers the overlap, so the solid is left to it.
// A point that leaves across n (rims straddling a post, pinched at its
// sides) does not, and the hull holds the solid off.
static bool pointIn(const scBox_t *b, const scHull_t *h, const double n[3])
{
    const bool standing = grounded(b, floorZ * WS);
    for (int k = 0; k < SC_HULL_POINTS; k++) {
        const double *v = h->v[k];
        if (v[0] > b->min[0] + FACE_EPS && v[0] < b->max[0] - FACE_EPS && v[1] > b->min[1] + FACE_EPS
            && v[1] < b->max[1] - FACE_EPS && v[2] > b->min[2] + FACE_EPS && v[2] < b->max[2] - FACE_EPS) {
            int ax = -1;
            double least = INFINITY;
            for (int a = 0; a < 3; a++) {
                if (!(a == 1 && standing) && v[a] - b->min[a] < least) {
                    least = v[a] - b->min[a];
                    ax = a;
                }
                if (b->max[a] - v[a] < least) {
                    least = b->max[a] - v[a];
                    ax = a;
                }
            }
            if (fabs(n[ax]) >= 0.5) {
                return true;
            }
        }
    }
    return false;
}

// The x-th deepest of the max contacts in out and c, with c going in at at.
static const sc_hull_contact_t *nthContact(const sc_hull_contact_t *out, int at, const sc_hull_contact_t *c, int x)
{
    return x < at ? &out[x] : x == at ? c : &out[x - 1];
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
        if (h.hi[0] <= b->min[0] + FACE_EPS) {
            break;                      // in order of min x: this and the rest start past the hull
        }
        bool apart = false;
        for (int k = 0; k < 3 && !apart; k++) {
            apart = h.hi[k] <= b->min[k] + FACE_EPS || h.lo[k] >= b->max[k] - FACE_EPS;
        }
        if (apart) {
            continue;
        }
        double n[3];
        const double depth = hullDepth(b, &h, n);
        if (!(depth > 0)) {
            continue;
        }
        // A solid a footprint point is inside, leaving along n: the point
        // resolves it.
        if (pointIn(b, &h, n)) {
            continue;
        }
        // A solid the hull began the tick in at least as deep (a pose, or a
        // post through the quad's middle): not passing into it this tick. One
        // it began in less deep is pushed back only as far as it went deeper
        // this tick: all of a carried overlap at once (19 mm) threw the quad
        // into the next post, and that one threw it back. A solid a point
        // began the tick inside, leaving along n, is left to that point (a
        // thin wall through the quad, held at its depth by the hull, kept a
        // rim inside it).
        if (!start0) {
            hullAt(start, &h0);
            start0 = true;
        }
        double n0[3];
        const double depth0 = hullDepth(b, &h0, n0);
        if ((depth0 > 0 && depth <= depth0 + FACE_EPS) || pointIn(b, &h0, n)) {
            continue;
        }
        const double deeper = depth0 > 0 ? depth - depth0 : depth;
        double held[SC_HULL_HOLD][3];
        const int points = holdPoints(b, &h, n, held);
        if (!points) {
            continue;
        }
        sc_hull_contact_t c;
        for (int j = 0; j < points; j++) {
            world2mod(held[j], c.point[j]);
        }
        c.points = points;
        c.normal[0] = -n[2];
        c.normal[1] = -n[0];
        c.normal[2] = n[1];
        c.depth = depth / WS;
        c.gain = deeper / WS;
        // Pushed back along a box face's axis, as a point is, by what it went
        // deeper this tick along n: the face most along n, or failing that the
        // next most along it, any at least a quarter along it (a push at most
        // four times what it went deeper; half along it, the plank of 46 went
        // on into the hull beside the leg), whose push takes no footprint point under the floor or into a
        // solid it was not in. With none, no push: the contact's response
        // holds it (only stopping the hull moving into the box,
        // sc_world_hull_hit). Keyed by that face (or the one most along n),
        // on the piece there.
        int order[3] = { 0, 1, 2 };     // axes by |n|, ties in axis order
        for (int j = 1; j < 3; j++) {
            for (int k = j; k > 0 && fabs(n[order[k]]) > fabs(n[order[k - 1]]); k--) {
                const int t = order[k];
                order[k] = order[k - 1];
                order[k - 1] = t;
            }
        }
        double push[3] = { 0, 0, 0 };
        c.ax = order[0];
        for (int j = 0; j < 3 && fabs(n[order[j]]) >= 0.25; j++) {
            if (!drivesIn(&h, order[j], deeper / n[order[j]])) {
                c.ax = order[j];
                push[c.ax] = deeper / n[c.ax];
                break;
            }
        }
        c.side = n[c.ax] > 0 ? 1 : -1;
        c.box = pieceAt(i, c.ax, c.side, held[0]);
        world2mod(push, c.push);
        // The deepest max; among equals, in order of position (the order of
        // the solids here), not the map's order. Compared as stored, so equal
        // depths are equal. Full, the one left out is the shallowest whose
        // face a deeper one has too, or failing that the shallowest: a box
        // top's corners never crowd a post's side out.
        int at = count;
        while (at > 0 && out[at - 1].depth < c.depth) {
            at--;
        }
        if (count < max) {
            for (int k = count; k > at; k--) {
                out[k] = out[k - 1];
            }
            out[at] = c;
            count++;
            continue;
        }
        int drop = max;
        bool shared = false;
        for (int x = max; x > 0 && !shared; x--) {
            const sc_hull_contact_t *cx = nthContact(out, at, &c, x);
            for (int y = 0; y < x && !shared; y++) {
                const sc_hull_contact_t *cy = nthContact(out, at, &c, y);
                shared = cy->ax == cx->ax && cy->side == cx->side;
            }
            if (shared) {
                drop = x;
            }
        }
        if (drop == at) {
            continue;
        }
        if (drop < at) {
            for (int k = drop; k < at - 1; k++) {
                out[k] = out[k + 1];
            }
            out[at - 1] = c;
        } else {
            for (int k = drop - 1; k > at; k--) {
                out[k] = out[k - 1];
            }
            out[at] = c;
        }
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
    // A contact the hull is not pushed out of (each push tried takes a point
    // into the solid or under the floor) only stops it moving into the box: no
    // bounce, and no holding the speed it was leaving at. Holding it fought
    // the points on the far side of a thin wall posed through the quad, and
    // the quad wound up to the spin cap and 4.6 m/s with its motors below
    // hover.
    if (!(c->push[0] || c->push[1] || c->push[2])) {
        const double u[3] = { -normal[1], normal[2], -normal[0] };
        const double un = vdot(cv, u);
        if (un > 0) {
            for (int k = 0; k < 3; k++) {
                cv[k] -= un * u[k];
            }
        }
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

bool sc_world_point_in(const double pos[3])
{
    double w[3];
    mod2world(pos, w);
    const double floorY = floorZ * WS;
    if (w[1] < floorY - FACE_EPS) {
        return true;
    }
    for (int j = 0; j < boxCount; j++) {
        const scBox_t *b = &boxes[j];
        if (w[0] > b->min[0] + FACE_EPS && w[0] < b->max[0] - FACE_EPS && w[2] > b->min[2] + FACE_EPS
            && w[2] < b->max[2] - FACE_EPS && w[1] < b->max[1] - FACE_EPS
            && (w[1] > b->min[1] + FACE_EPS || (grounded(b, floorY) && w[1] >= floorY - FACE_EPS))) {
            return true;
        }
    }
    return false;
}

bool sc_world_in_solid(const double pos[3])
{
    double w[3];
    mod2world(pos, w);
    for (int j = 0; j < boxCount; j++) {
        if (contains(&boxes[j], w)) {
            return true;
        }
    }
    return false;
}

void sc_world_after_points(const double com[3], bool floorHit)
{
    double cp[3];
    mod2world(com, cp);
    floorEdgeAndTriggers(cp, floorHit);
}
