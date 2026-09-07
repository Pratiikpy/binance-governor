"""Matrix hygiene for covariance work.

WHY THIS EXISTS AS ITS OWN MODULE
---------------------------------
Every optimiser downstream of a covariance matrix assumes it is positive
semi-definite. Almost nothing upstream guarantees that. Note 38 §5.6 measured the
consequence directly: ``Riskfolio.denoiseCov(..., detone=True)`` returns a matrix
with minimum eigenvalue ``-1.388e-04`` and *no warning*, its own ``is_pos_def``
says ``False``, and downstream ``scipy.linalg.sqrtm`` then returns a **complex**
matrix that cvxpy fails on with an opaque error. Note 24 found the same failure
path in ``Portfolio.py:2196``.

So the rule here is: **a function that can return a non-PSD matrix must either
repair it or raise.** Never return one silently. ``psd_guard`` is the choke point
and every estimator in ``covariance.py`` goes through it.

Two repair methods are offered because they are not interchangeable:

* ``clip``  — eigenvalue clipping. Fast, O(n^3) once, but it *changes the
  variances* (the diagonal) and it is not the nearest matrix in any norm.
* ``higham`` — Higham (2002) alternating projections onto the intersection of
  {symmetric PSD} and {unit diagonal}, applied on the *correlation* matrix so the
  variances are preserved exactly. This is the correct repair when the diagonal
  is meaningful, which for us it always is: the diagonal is the asset volatility
  we actually measured, and the off-diagonal is the part we are unsure about.

PyPortfolioOpt's ``_is_positive_semidefinite`` (``risk_models.py:49``) is a
Cholesky with ``+1e-16*I``, which tests positive *definiteness*, not
semi-definiteness — so a genuinely PSD-but-singular matrix warns and gets
"fixed", and its ``fix_method="spectral"`` is a no-op on an exactly-zero
eigenvalue. We separate the two tests here for that reason.
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "cov_to_corr",
    "corr_to_cov",
    "is_symmetric",
    "symmetrise",
    "min_eigenvalue",
    "is_positive_definite",
    "is_positive_semidefinite",
    "condition_number",
    "nearest_psd_clip",
    "nearest_correlation_higham",
    "psd_guard",
    "sqrtm_psd",
    "inv_psd",
    "solve_psd",
    "shrink_towards",
]

_EPS = np.finfo(float).eps


def symmetrise(a: np.ndarray) -> np.ndarray:
    """Return ``(A + A.T) / 2``.

    Numerical covariance code accumulates asymmetry of order 1e-16 per operation.
    Left alone it makes ``np.linalg.eigh`` and ``np.linalg.cholesky`` disagree
    about definiteness, which is exactly the class of bug that makes a solver
    silently pick a different branch on two runs of the same data.
    """
    a = np.asarray(a, dtype=float)
    return 0.5 * (a + a.T)


def is_symmetric(a: np.ndarray, tol: float = 1e-10) -> bool:
    a = np.asarray(a, dtype=float)
    if a.ndim != 2 or a.shape[0] != a.shape[1]:
        return False
    return bool(np.max(np.abs(a - a.T)) <= tol * max(1.0, float(np.max(np.abs(a)))))


def cov_to_corr(cov: np.ndarray) -> np.ndarray:
    """Covariance -> correlation, with zero-variance columns handled explicitly.

    A zero-variance column is not a numerical accident to be divided through; it
    means the asset did not move over the window, which happens constantly on a
    675-symbol perp panel where a newly listed instrument has a flat first hour.
    We map its correlations to zero and its own diagonal to one, so the matrix
    stays a valid correlation matrix and the asset carries no diversification
    claim. Riskfolio and PyPortfolioOpt both produce NaN here.
    """
    cov = symmetrise(cov)
    sd = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    nonzero = sd > 0
    inv = np.zeros_like(sd)
    inv[nonzero] = 1.0 / sd[nonzero]
    corr = cov * np.outer(inv, inv)
    corr[~nonzero, :] = 0.0
    corr[:, ~nonzero] = 0.0
    np.fill_diagonal(corr, 1.0)
    return np.clip(corr, -1.0, 1.0)


def corr_to_cov(corr: np.ndarray, std: np.ndarray) -> np.ndarray:
    """Correlation + standard deviations -> covariance."""
    corr = symmetrise(corr)
    std = np.asarray(std, dtype=float).ravel()
    if std.shape[0] != corr.shape[0]:
        raise ValueError(f"std has length {std.shape[0]}, corr is {corr.shape}")
    if np.any(std < 0):
        raise ValueError("standard deviations must be non-negative")
    return symmetrise(corr * np.outer(std, std))


def min_eigenvalue(a: np.ndarray) -> float:
    """Smallest eigenvalue of a symmetric matrix, via ``eigvalsh``."""
    return float(np.linalg.eigvalsh(symmetrise(a))[0])


def is_positive_definite(a: np.ndarray) -> bool:
    """Strict positive definiteness, tested by Cholesky.

    Cholesky is ~100x faster than an eigendecomposition and is the operation the
    downstream solvers actually perform, so it is the honest test of "will this
    work".
    """
    try:
        np.linalg.cholesky(symmetrise(a))
        return True
    except np.linalg.LinAlgError:
        return False


def is_positive_semidefinite(a: np.ndarray, tol: float | None = None) -> bool:
    """PSD test that tolerates exact singularity.

    A rank-deficient but genuinely PSD matrix — a k-factor covariance with k < n,
    or a detoned correlation — is legitimate input to a *constrained* optimiser
    and illegitimate input to anything that inverts. Keep the two questions
    separate; PyPortfolioOpt conflates them.
    """
    a = symmetrise(a)
    if tol is None:
        tol = 1e-10 * max(1.0, float(np.max(np.abs(np.diag(a)))))
    return bool(np.linalg.eigvalsh(a)[0] >= -abs(tol))


def condition_number(a: np.ndarray) -> float:
    """``lambda_max / lambda_min`` of a symmetric matrix; ``inf`` if singular.

    riskparity.py ships this test inverted (``max/min < 1e-6``, ``rpp.py:161``),
    which can never fire because the ratio is always >= 1. Ours returns the
    number and lets the caller compare.
    """
    ev = np.linalg.eigvalsh(symmetrise(a))
    lo, hi = float(ev[0]), float(ev[-1])
    if lo <= 0:
        return float("inf")
    return hi / lo


def nearest_psd_clip(a: np.ndarray, epsilon: float = 0.0) -> np.ndarray:
    """Eigenvalue clipping: set every eigenvalue below ``epsilon`` to ``epsilon``.

    Cheap and always succeeds, but it *moves the diagonal*. Use it when the
    matrix is an intermediate quantity (e.g. an augmented Schur block) and the
    variances carry no external meaning. For a covariance whose diagonal is a
    measured volatility, prefer ``nearest_correlation_higham``.
    """
    a = symmetrise(a)
    vals, vecs = np.linalg.eigh(a)
    vals = np.clip(vals, epsilon, None)
    return symmetrise((vecs * vals) @ vecs.T)


def nearest_correlation_higham(
    corr: np.ndarray,
    *,
    max_iterations: int = 200,
    tol: float = 1e-9,
) -> np.ndarray:
    """Higham (2002) nearest correlation matrix by alternating projections.

    Solves ``min ||X - C||_F`` over ``{X : X = X.T, X >= 0, diag(X) = 1}`` using
    Dykstra's correction, which is what makes the alternating projection converge
    to the *nearest* point rather than merely to a feasible one. Without the
    correction (the naive "clip then reset diagonal" loop that most libraries
    ship) the limit depends on the starting point and is not the projection.

    The variances are preserved exactly by construction because we work on the
    correlation matrix and rescale afterwards; this is the whole reason to prefer
    it over clipping when the diagonal is measured data.

    Reference
    ---------
    N. J. Higham, "Computing the nearest correlation matrix - a problem from
    finance", IMA J. Numer. Anal. 22(3), 2002, 329-343.
    """
    corr = symmetrise(corr)
    n = corr.shape[0]
    delta_s = np.zeros_like(corr)
    y = corr.copy()
    x = corr.copy()
    for _ in range(max_iterations):
        r = y - delta_s
        # Projection onto the PSD cone.
        vals, vecs = np.linalg.eigh(symmetrise(r))
        vals = np.clip(vals, 0.0, None)
        x_new = symmetrise((vecs * vals) @ vecs.T)
        delta_s = x_new - r
        # Projection onto the unit-diagonal set.
        y_new = x_new.copy()
        np.fill_diagonal(y_new, 1.0)
        if (
            np.linalg.norm(y_new - y, ord="fro")
            <= tol * max(1.0, np.linalg.norm(y_new, ord="fro"))
            and np.linalg.norm(x_new - x, ord="fro")
            <= tol * max(1.0, np.linalg.norm(x_new, ord="fro"))
        ):
            x, y = x_new, y_new
            break
        x, y = x_new, y_new
    out = symmetrise(y)
    np.fill_diagonal(out, 1.0)
    return np.clip(out, -1.0, 1.0)


def psd_guard(
    cov: np.ndarray,
    *,
    method: str = "higham",
    epsilon: float = 0.0,
    require_pd: bool = False,
    raise_on_repair: bool = False,
) -> tuple[np.ndarray, dict]:
    """The single choke point every covariance estimator returns through.

    Returns ``(matrix, diagnostics)``. ``diagnostics`` always records whether a
    repair happened, the eigenvalue before and after, and the method — because a
    silent repair is how a garbage matrix reaches a solver and comes back as a
    plausible weight vector.

    Parameters
    ----------
    method : {"higham", "clip", "none"}
        ``"none"`` performs the check and raises rather than repairing. Use it
        in tests and in any path where a repair would mask an upstream bug.
    require_pd : bool
        If True, demand strict positive definiteness (Cholesky) rather than
        semi-definiteness. Set this whenever the caller will invert the matrix.
    raise_on_repair : bool
        Turn a repair into an error. The deploy-time setting for anything whose
        output we publish.
    """
    cov = symmetrise(cov)
    lam_before = min_eigenvalue(cov)
    ok = is_positive_definite(cov) if require_pd else is_positive_semidefinite(cov)
    diag = {
        "min_eigenvalue_before": lam_before,
        "repaired": False,
        "method": method,
        "require_pd": require_pd,
    }
    if ok:
        diag["min_eigenvalue_after"] = lam_before
        return cov, diag
    if raise_on_repair or method == "none":
        raise ValueError(
            f"covariance is not {'positive definite' if require_pd else 'PSD'}: "
            f"min eigenvalue {lam_before:.6g}"
        )
    floor = epsilon
    if require_pd and floor <= 0.0:
        scale = float(np.max(np.abs(np.diag(cov))))
        floor = max(1e-12, 1e-10 * (scale if scale > 0 else 1.0))
    if method == "clip":
        out = nearest_psd_clip(cov, epsilon=floor)
    elif method == "higham":
        sd = np.sqrt(np.clip(np.diag(cov), 0.0, None))
        corr = cov_to_corr(cov)
        corr = nearest_correlation_higham(corr)
        if require_pd:
            corr = nearest_psd_clip(corr, epsilon=max(floor, 1e-12))
            d = np.sqrt(np.clip(np.diag(corr), _EPS, None))
            corr = corr / np.outer(d, d)
            np.fill_diagonal(corr, 1.0)
        out = corr_to_cov(corr, sd)
        if require_pd and not is_positive_definite(out):
            out = nearest_psd_clip(out, epsilon=floor)
    else:
        raise ValueError(f"unknown psd repair method {method!r}")
    diag["repaired"] = True
    diag["min_eigenvalue_after"] = min_eigenvalue(out)
    still_bad = (
        not is_positive_definite(out) if require_pd else not is_positive_semidefinite(out)
    )
    if still_bad:
        raise ValueError(
            "PSD repair failed: min eigenvalue "
            f"{diag['min_eigenvalue_after']:.6g} after {method}"
        )
    return out, diag


def sqrtm_psd(a: np.ndarray) -> np.ndarray:
    """Symmetric PSD square root via ``eigh``.

    Deliberately *not* ``scipy.linalg.sqrtm``: on a matrix with any tiny negative
    eigenvalue that returns a complex matrix, and cvxpy then fails several frames
    later with an error that does not name the cause (note 24, Riskfolio
    ``Portfolio.py:2196``). Here a negative eigenvalue is an error at the point it
    occurs.
    """
    a = symmetrise(a)
    vals, vecs = np.linalg.eigh(a)
    if vals[0] < -1e-10 * max(1.0, float(np.max(np.abs(vals)))):
        raise ValueError(f"matrix is not PSD: min eigenvalue {vals[0]:.6g}")
    vals = np.clip(vals, 0.0, None)
    return symmetrise((vecs * np.sqrt(vals)) @ vecs.T)


def inv_psd(a: np.ndarray, *, ridge: float = 0.0) -> np.ndarray:
    """Inverse of a PSD matrix, optionally ridged, via Cholesky.

    ``ridge`` is expressed as a fraction of the mean diagonal so it is
    scale-free: feeding a covariance in percent^2 rather than decimal^2 does not
    silently change its effect. riskparity.py's ``tau = 1e-4`` is exactly this
    mistake (note 24 §3).
    """
    a = symmetrise(a)
    if ridge > 0:
        a = a + np.eye(a.shape[0]) * ridge * float(np.mean(np.diag(a)))
    try:
        c = np.linalg.cholesky(a)
    except np.linalg.LinAlgError as exc:
        raise ValueError(
            f"matrix not positive definite (min eigenvalue {min_eigenvalue(a):.6g}); "
            "pass ridge>0 or repair it first"
        ) from exc
    inv_c = np.linalg.inv(c)
    return symmetrise(inv_c.T @ inv_c)


def solve_psd(a: np.ndarray, b: np.ndarray, *, ridge: float = 0.0) -> np.ndarray:
    """``A^-1 B`` by Cholesky solve. More accurate than forming the inverse."""
    a = symmetrise(a)
    if ridge > 0:
        a = a + np.eye(a.shape[0]) * ridge * float(np.mean(np.diag(a)))
    try:
        c = np.linalg.cholesky(a)
    except np.linalg.LinAlgError as exc:
        raise ValueError(
            f"matrix not positive definite (min eigenvalue {min_eigenvalue(a):.6g})"
        ) from exc
    return np.linalg.solve(c.T, np.linalg.solve(c, b))


def shrink_towards(
    sample: np.ndarray, target: np.ndarray, intensity: float
) -> np.ndarray:
    """``(1 - d) * sample + d * target`` with ``d`` clipped to [0, 1].

    Trivial, but it is the one place the shrinkage intensity is range-checked.
    An intensity outside [0, 1] is an extrapolation away from the target and is
    never what a shrinkage estimator intends; several published analytic formulas
    can produce one on small samples.
    """
    d = float(np.clip(intensity, 0.0, 1.0))
    return symmetrise((1.0 - d) * symmetrise(sample) + d * symmetrise(target))
