import os
import sys
from pathlib import Path

import numpy as np
import pybind11
from setuptools import Extension, setup

HERE = Path(__file__).parent.resolve()


def _openmp_flags():
    """Return (compile_args, link_args, include_dirs, library_dirs) for OpenMP.

    GCC (Linux / Docker) supports -fopenmp natively. Apple clang does not, so on
    macOS we use Homebrew's libomp when it is installed and otherwise build a
    single-threaded engine (the OpenMP pragmas are simply ignored).
    Set ACM_DISABLE_OPENMP=1 to force a single-threaded build.
    """
    if os.environ.get("ACM_DISABLE_OPENMP") == "1":
        return [], [], [], []
    if sys.platform == "darwin":
        for prefix in ("/opt/homebrew/opt/libomp", "/usr/local/opt/libomp"):
            if Path(prefix, "include", "omp.h").exists():
                return (
                    ["-Xpreprocessor", "-fopenmp"],
                    ["-lomp"],
                    [f"{prefix}/include"],
                    [f"{prefix}/lib"],
                )
        return [], [], [], []
    if sys.platform == "win32":
        return ["/openmp"], [], [], []
    return ["-fopenmp"], ["-fopenmp"], [], []


omp_compile, omp_link, omp_includes, omp_libdirs = _openmp_flags()

if sys.platform == "win32":
    base_compile = ["/std:c++20", "/O2"]
else:
    base_compile = ["-std=c++20", "-O3", "-fPIC", "-ffast-math"]

ext_modules = [
    Extension(
        "acm_engine",  # top-level module name imported by satellite_api.physics_engine
        sources=["acm_engine/physics_rk4.cpp"],
        include_dirs=[pybind11.get_include(), np.get_include(), *omp_includes],
        library_dirs=omp_libdirs,
        language="c++",
        extra_compile_args=base_compile + omp_compile,
        extra_link_args=omp_link,
    ),
]


def _read_requirements():
    req_file = HERE / "requirements.txt"
    if not req_file.exists():
        return []
    return [
        line.strip()
        for line in req_file.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]


setup(
    name="acm_engine",
    version="1.0.0",
    description="High-Performance Zero-Copy SDA Engine via PyBind11",
    ext_modules=ext_modules,
    install_requires=_read_requirements(),
    zip_safe=False,
)
