"""THE PRINTABLE MODEL. Hand-modelled (parametric CSG with manifold3d) pirate ship.
Every number below was read off the scan tables printed by 04_measure_scan.py (90 mm length, hull squared up),
then slimmed ~1-2 mm where the visual hull is known to run fat. For a different object, keep the helpers
(loft, cyl, box, sail_surface, rig_sail) and rewrite the part list + numbers from your own measurements.
Units mm, Z up, bow towards -X, flat base at Z=0. Writes pirate_ship_clean.stl / .3mf in the current folder."""
import numpy as np, trimesh
import manifold3d as mf
from scipy.interpolate import PchipInterpolator as Pchip

M = mf.Manifold
SEG = 32

def from_arrays(V, F):
    return M(mf.Mesh(vert_properties=np.asarray(V, np.float32), tri_verts=np.asarray(F, np.uint32)))

def cyl(p0, p1, r, seg=SEG):
    """Cylinder between two points."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float); d = p1 - p0; L = np.linalg.norm(d); d /= L
    c = M.cylinder(L, r, r, seg)
    tilt = np.degrees(np.arccos(np.clip(d[2], -1, 1))); yaw = np.degrees(np.arctan2(d[1], d[0]))
    return c.rotate((0, tilt, 0)).rotate((0, 0, yaw)).translate(tuple(p0))

def box(center, size, rot=(0, 0, 0)):
    return M.cube(tuple(size), True).rotate(tuple(rot)).translate(tuple(center))

def loft(xs, section):
    """Closed solid from cross-sections: section(x) -> (K,2) array of (y,z), counter-clockwise, same K for all."""
    rings = [np.column_stack([np.full(len(s), x), s]) for x in xs for s in [section(x)]]
    K = len(rings[0]); V = np.vstack(rings + [rings[0].mean(0), rings[-1].mean(0)]); F = []
    n = len(xs)
    for i in range(n - 1):
        for k in range(K):
            a, b = i * K + k, i * K + (k + 1) % K; c, d = a + K, b + K
            F += [(a, c, b), (b, c, d)]
    c0, c1 = n * K, n * K + 1
    for k in range(K):
        F.append((c0, k, (k + 1) % K)); F.append((c1, (n - 1) * K + (k + 1) % K, (n - 1) * K + k))
    m = from_arrays(V, F)
    if m.volume() < 0 or m.status() != mf.Error.NoError:
        m = from_arrays(V, [f[::-1] for f in F])
    assert m.status() == mf.Error.NoError, m.status()
    return m

# ---------------- hull (profiles measured from the scan, slightly slimmed: the visual hull runs ~1-2 mm fat)
BOW, STERN = -37.0, 42.0
beam = Pchip([-37, -34, -28, -20, -10, 4, 16, 28, 36, 42], [0.6, 6.5, 12.5, 16.0, 17.6, 17.8, 17.0, 15.8, 14.4, 13.0])
keel = Pchip([-37, -34, -30, -25, -18, -10, 10, 25, 33, 38, 42], [24, 14, 7.5, 2.5, -1.5, -2.2, -2.2, -1.8, 1.0, 5.0, 11.0])
sheer = Pchip([-37, -26, -20, -14, -6, 12, 15.6, 16.0, 42], [34.5, 34, 28, 22.5, 21, 21, 22, 38, 38.5])
DECK_FORE, DECK_MAIN, DECK_AFT = 27.0, 14.0, 30.0
def deck(x):
    return DECK_FORE if x < -25 else (DECK_AFT if x > 17.0 else DECK_MAIN)

def half_width(x, z):
    zk, zg, B = keel(x), sheer(x), beam(x)
    zb = max(zk + 3.0, min(14.0, zk + 0.7 * (zg - zk)))     # height of max beam
    if z < zb:
        t = np.clip((zb - z) / (zb - zk), 0, 1); return B * np.sqrt(max(1 - t * t, 0.0025))
    return B * (1 - 0.07 * (z - zb) / max(zg - zb, 1))          # slight tumblehome

def outer_section(x, K=28):
    zk, zg = keel(x), sheer(x)
    zs = zk + (zg - zk) * (1 - np.cos(np.linspace(0, np.pi / 2, K))) ** 1.0  # denser near the keel
    zs[0] = zk + 0.02
    right = [(half_width(x, z), z) for z in zs]
    return np.array(right + [(-y, z) for y, z in right[::-1]])

WALL = 2.3
def inner_section(x, K=12):
    zd, zt = deck(x), sheer(x) + 3
    zs = np.linspace(zd, zt, K)
    right = [(max(half_width(x, z) - WALL, 0.3), z) for z in zs]
    return np.array(right + [(-y, z) for y, z in right[::-1]])

xs = np.concatenate([np.linspace(BOW, -30, 30), np.linspace(-30, 40, 141)[1:], np.linspace(40, STERN, 6)[1:]])
xs[1:-1] += 0.137                                   # keep loft stations off the deck/castle break lines (avoids coincident vertices)
hull = loft(xs, outer_section)
xi = np.linspace(-31.0, STERN - WALL, 160)
xi = xi[[half_width(x, deck(x) + 1) - WALL > 1.2 for x in xi]]
# deck steps: split the cut at each level change so step walls stay vertical
cut = None
for lo, hi in [(-99, -25), (-25, 17.0), (17.0, 99)]:
    seg_x = xi[(xi > lo) & (xi < (hi - 2.0 if hi < 99 else hi))]
    if len(seg_x) < 2: continue
    seg_x = np.concatenate([[max(seg_x[0], lo + 1.0 if lo > -99 else seg_x[0])], seg_x[1:-1], [min(seg_x[-1], hi - 2.0 if hi < 99 else seg_x[-1])]])
    part = loft(seg_x, inner_section)
    cut = part if cut is None else cut + part
hull = hull - cut

# rails along the gunwale tops (rope-trim look) are skipped; add cannons + portholes + stern windows
details_add, details_sub = [], []
for x in (-17, -5, 7):
    for s in (1, -1):
        yw = half_width(x, 17.5)
        details_add.append(cyl((x, s * (yw - 1.5), 17.5), (x, s * (yw + 2.4), 17.5), 1.2, 20))
for x in (-20, -9, 2, 13, 25, 34):
    for s in (1, -1):
        z = 9.5; yw = half_width(x, z)
        details_sub.append(cyl((x, s * (yw - 0.9), z), (x, s * (yw + 3), z), 1.3, 20))
for y in (-6.5, 0, 6.5):
    details_sub.append(box((STERN + 0.4, y, 33.5), (2.0, 3.0, 4.0)))         # transom windows
for x in (22, 29, 36):
    for s in (1, -1):
        yw = half_width(x, 34)
        details_sub.append(box((x, s * (yw + 0.2), 34), (3.0, 1.6, 3.4)))      # castle side windows
hull = hull + M.batch_boolean(details_add, mf.OpType.Add)
hull = hull - M.batch_boolean(details_sub, mf.OpType.Add)

# ---------------- masts, bowsprit, yards
MAIN_X, MIZ_X = -12.0, 27.0
parts = [hull,
         cyl((MAIN_X, 0, DECK_MAIN - 4), (MAIN_X, 0, 81.5), 1.45),
         cyl((MIZ_X, 0, DECK_AFT - 4), (MIZ_X, 0, 75.0), 1.3),
         cyl((-31, 0, 30.5), (-46.5, 0, 37.5), 1.3)]
parts.append(M.sphere(1.6, 20).translate((-46.5, 0, 37.5)))
parts.append(M.sphere(1.5, 20).translate((MIZ_X, 0, 75.0)))

# ---------------- sails: curved panels (billow towards the bow), straight top/bottom edges on yards
T_SAIL = 1.6
def sail_surface(z0, z1, hw0, hw1, sag, back_x, nu=40, nv=30, offset=0.0):
    """Closed solid between the back face (x = back_x - billow) and the front face T_SAIL further forward.
    offset > 0 pushes the front face further forward (used for relief emblems)."""
    u = np.linspace(-1, 1, nu); v = np.linspace(0, 1, nv); U, Vv = np.meshgrid(u, v, indexing="ij")
    hw = hw0 + (hw1 - hw0) * Vv
    Y = U * hw; Z = z0 + (z1 - z0) * Vv
    bil = sag * (1 - U ** 2) * np.sin(np.pi * Vv)
    Xb = back_x - bil; Xf = Xb - T_SAIL - offset
    back = np.stack([Xb, Y, Z], -1).reshape(-1, 3); front = np.stack([Xf, Y, Z], -1).reshape(-1, 3)
    V = np.vstack([back, front]); off = len(back); F = []
    idx = lambda i, j: i * nv + j
    for i in range(nu - 1):
        for j in range(nv - 1):
            a, b, c, d = idx(i, j), idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1)
            F += [(a, b, d), (a, d, c), (a + off, d + off, b + off), (a + off, c + off, d + off)]
    ring = [idx(i, 0) for i in range(nu)] + [idx(nu - 1, j) for j in range(1, nv)] + \
           [idx(i, nv - 1) for i in range(nu - 2, -1, -1)] + [idx(0, j) for j in range(nv - 2, 0, -1)]
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        F += [(a, a + off, b), (b, a + off, b + off)]
    m = from_arrays(V, F)
    if m.volume() < 0 or m.status() != mf.Error.NoError:
        m = from_arrays(V, [f[::-1] for f in F])
    assert m.status() == mf.Error.NoError, m.status()
    return m

def rig_sail(mast_x, z0, z1, hw0, hw1, sag, emblem=None, yaw=0.0):
    back = mast_x - 0.6                                    # back face sits inside the mast
    sail = sail_surface(z0, z1, hw0, hw1, sag, back)
    out = [sail,
           cyl((back - 0.8, -hw0 - 1.2, z0), (back - 0.8, hw0 + 1.2, z0), 1.0, 16),   # yards
           cyl((back - 0.8, -hw1 - 1.2, z1), (back - 0.8, hw1 + 1.2, z1), 1.0, 16)]
    if emblem is not None:
        relief = sail_surface(z0, z1, hw0, hw1, sag, back, offset=0.7) ^ emblem(back, z0, z1)
        out.append(relief)
    s = M.batch_boolean(out, mf.OpType.Add)
    if yaw:
        s = s.translate((-mast_x, 0, 0)).rotate((0, 0, yaw)).translate((mast_x, 0, 0))
    return s

def x_prism(shape_yz, x0=-80, x1=80):
    """Extrude a 2-D (y,z) shape built from 3-D primitives: helpers return solids spanning x."""
    return shape_yz

def skull(back, z0, z1):
    zc = (z0 + z1) / 2 + 2.0; L = 60
    head = cyl((back - L / 2, 0, zc), (back + L / 2, 0, zc), 3.0, 28)
    jaw = box((back, 0, zc - 2.8), (L, 3.4, 2.4))
    eyes = [cyl((back - L / 2, s * 1.2, zc + 0.2), (back + L / 2, s * 1.2, zc + 0.2), 0.75, 12) for s in (1, -1)]
    nose = box((back, 0, zc - 1.4), (L, 0.8, 0.9))
    bones = [box((back, 0, zc - 6.6), (L, 12.0, 1.5), rot=(a, 0, 0)) for a in (32, -32)]
    ends = [M.sphere(1.0, 12).scale((L / 2, 1, 1)).translate((back, s1 * 5.1 * np.cos(np.radians(32)), zc - 6.6 + s2 * 5.1 * np.sin(np.radians(32))))
            for s1 in (1, -1) for s2 in (1, -1)]
    return (head + jaw + M.batch_boolean(bones + ends, mf.OpType.Add)) - M.batch_boolean(eyes + [nose], mf.OpType.Add)

def ring_emblem(back, z0, z1):
    zc = (z0 + z1) / 2; L = 60
    ring = cyl((back - L / 2, 0, zc), (back + L / 2, 0, zc), 5.2, 40) - cyl((back - L / 2 - 1, 0, zc), (back + L / 2 + 1, 0, zc), 4.0, 40)
    swords = [box((back, 0, zc), (L, 26.0, 1.2), rot=(a, 0, 0)) for a in (14, -14)]
    return ring + M.batch_boolean(swords, mf.OpType.Add)

parts.append(rig_sail(MAIN_X, 36.0, 51.0, 23.0, 17.0, 4.0, ring_emblem))      # main course
parts.append(rig_sail(MAIN_X, 54.0, 71.5, 19.5, 12.5, 3.5, skull))            # main topsail
parts.append(rig_sail(MIZ_X, 50.0, 66.0, 14.0, 10.5, 3.0, skull, yaw=5.0))    # mizzen (yaw measured from scan)

# ---------------- crow's nest (crown-like cup)
cn = cyl((MAIN_X, 0, 73.0), (MAIN_X, 0, 79.0), 3.4, 36) + cyl((MAIN_X, 0, 78.4), (MAIN_X, 0, 80.4), 4.2, 36)
cn = cn + M.cylinder(2.0, 1.4, 3.4, 36).translate((MAIN_X, 0, 71.0))           # tapered underside: prints without support
cn = cn - cyl((MAIN_X, 0, 76.5), (MAIN_X, 0, 81.0), 2.2, 36)
cn = cn - M.batch_boolean([box((MAIN_X, 0, 80.2), (10, 1.4, 1.6), rot=(0, 0, a)) for a in (0, 60, 120)], mf.OpType.Add)
parts.append(cn)
parts.append(cyl((MAIN_X, 0, 76.0), (MAIN_X, 0, 82.5), 1.45))
parts.append(M.sphere(1.7, 20).translate((MAIN_X, 0, 82.5)))

ship = M.batch_boolean(parts, mf.OpType.Add)
ship = ship.trim_by_plane((0, 0, 1), 0.0)            # flat base
ship = ship.simplify(0.005)                          # collapse zero-area slivers left by coplanar booleans
pieces = ship.decompose()
ship = max(pieces, key=lambda p: p.volume())
print("pieces before keep-largest:", len(pieces), [round(p.volume(), 1) for p in pieces])
mesh = ship.to_mesh()
t = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
print("status", ship.status(), "watertight", t.is_watertight, "nonmanifold edges", int((np.bincount(t.edges_unique_inverse) != 2).sum()), "bodies", len(t.split(only_watertight=False)), "genus", ship.genus())
print("extents mm (L x W x H)", t.extents.round(1), "bounds", t.bounds.round(1).tolist(), "volume cm3", round(t.volume / 1000, 1), "tris", len(t.faces))
print("base footprint", round(ship.slice(0.05).area(), 0), "mm2")
t.export("pirate_ship_clean.stl"); t.export("pirate_ship_clean.3mf")
