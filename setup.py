from setuptools import setup, Extension
import pybind11
import numpy as np

ext_modules = [
    Extension(
        "acm_engine",
        sources=[
            "cpp_engine/physics_rk4.cpp"
        ],
        include_dirs=[
            pybind11.get_include(),
            np.get_include(),
            "acm_engine"
        ],
        language="c++",
        extra_compile_args=["-std=c++20", "-O3", "-fPIC"],
        extra_link_args=["-std=c++20"],
    ),
]

setup(
    name="acm_engine",
    version="1.0.0",
    description="High-Performance SDA Engine via PyBind11",
    ext_modules=ext_modules,
    zip_safe=False,
)