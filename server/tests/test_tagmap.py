import numpy as np

from seefy import geometry as g
from seefy.tagmap import Frame, solve

SIZE = 0.10
ORIGIN_SIZE = 0.20
K = np.array([[900.0, 0, 640], [0, 900.0, 360], [0, 0, 1]])


def pose(x_axis, y_axis, z_axis, t):
    T = np.eye(4)
    T[:3, :3] = np.column_stack([x_axis, y_axis, z_axis])
    T[:3, 3] = t
    return T


# Origin flat on the floor; three tags on walls of a 4 x 3 m room, facing inwards.
TRUE_TAGS = {
    0: np.eye(4),
    1: pose([0, -1, 0], [0, 0, 1], [-1, 0, 0], [3.0, 0.5, 1.2]),  # wall at x = 3
    2: pose([1, 0, 0], [0, 0, 1], [0, -1, 0], [1.0, 2.5, 1.0]),  # wall at y = 2.5
    3: pose([0, 1, 0], [0, 0, 1], [1, 0, 0], [-1.0, 1.0, 1.4]),  # wall at x = -1
}


def look_at(cam, target):
    z = np.asarray(target, float) - cam
    z /= np.linalg.norm(z)
    x = np.cross([0, 0, -1.0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return g.inv(pose(x, y, z, cam))  # T_cam_world


def synth_frames(rng, n, noise_px, pass_id, tags=None, size_of=None, box=((-0.5, 2.5), (-0.2, 2.0))):
    tags = tags or TRUE_TAGS
    size_of = size_of or (lambda i: ORIGIN_SIZE if i == 0 else SIZE)
    frames = []
    while len(frames) < n:
        cam = np.array([rng.uniform(*box[0]), rng.uniform(*box[1]), rng.uniform(1.0, 1.6)])
        a, b = rng.choice(list(tags), 2, replace=False)
        target = (tags[a][:3, 3] + tags[b][:3, 3]) / 2
        T_cw = look_at(cam, target)
        dets = {}
        for i, T in tags.items():
            local = g.tag_corners(size_of(i))
            facing = np.dot(T[:3, 2], cam - T[:3, 3]) > 0
            pc = g.transform(T_cw, g.transform(T, local))
            if not facing or np.any(pc[:, 2] < 0.2):
                continue
            uv = g.project(K, T_cw, g.transform(T, local))
            if np.all((uv > 0) & (uv < [1280, 720])):
                dets[i] = uv + rng.normal(0, noise_px, uv.shape)
        if len(dets) >= 2:
            frames.append(Frame(len(frames), "test", pass_id, K, dets))
    return frames


def position_error(sol):
    return max(np.linalg.norm(sol.tags[i][:3, 3] - TRUE_TAGS[i][:3, 3]) for i in TRUE_TAGS)


def test_solve_recovers_tag_positions():
    rng = np.random.default_rng(1)
    sol = solve(synth_frames(rng, 120, 0.5, "a"), SIZE, 0, 1.5, 3, 2000, ORIGIN_SIZE)
    assert set(sol.tags) == set(TRUE_TAGS)
    assert position_error(sol) < 0.03  # within 3 cm at 0.5 px corner noise
    assert sol.rms_px < 1.0


def test_more_passes_improve_accuracy():
    rng = np.random.default_rng(2)
    passes = [synth_frames(rng, 25, 1.5, f"p{k}") for k in range(4)]
    one = position_error(solve(passes[0], SIZE, 0, 1.5, 3, 2000, ORIGIN_SIZE))
    four = position_error(solve([f for p in passes for f in p], SIZE, 0, 1.5, 3, 2000, ORIGIN_SIZE))
    assert four < one


def test_no_origin_means_no_map():
    rng = np.random.default_rng(3)
    frames = [f for f in synth_frames(rng, 60, 0.5, "a")]
    for f in frames:
        f.dets.pop(0, None)
    sol = solve([f for f in frames if len(f.dets) >= 2], SIZE, 0, 1.5, 3, 2000, ORIGIN_SIZE)
    assert sol.tags == {}


def test_screens_upright_origin_and_mixed_sizes():
    """Tags shown on screens: origin upright on a monitor 1 m up, each tag a different size."""
    tags = {
        0: g.origin_pose("upright", 1.0),  # monitor at y = 0, screen facing -y (into the room)
        1: pose([1, 0, 0], [0, 0, 1], [0, -1, 0], [1.4, 0.2, 0.8]),  # laptop on a desk beside the monitor
        2: pose([0, 1, 0], [0, 0, 1], [1, 0, 0], [-1.0, -1.0, 0.9]),  # phone propped on a side shelf
    }
    sizes = {0: 0.25, 1: 0.14, 2: 0.08}  # monitor, laptop, phone
    rng = np.random.default_rng(4)
    # The origin faces -y, so cameras stand on that side of it.
    frames = synth_frames(rng, 150, 0.4, "s", tags, sizes.get, box=((-0.5, 2.5), (-3.0, -0.6)))
    sol = solve(frames, SIZE, 0, 1.5, 3, 2000, ORIGIN_SIZE, sizes, g.origin_pose("upright", 1.0))
    assert set(sol.tags) == set(tags)
    err = max(np.linalg.norm(sol.tags[i][:3, 3] - tags[i][:3, 3]) for i in tags)
    assert err < 0.03
