from setuptools import setup, Extension
import pybind11
import numpy as np

ext_modules = [
    Extension(
        "acm_engine",  # This is what Python imports
        sources=[
            "acm_engine/physics_rk4.cpp"  # This is where the source code lives
        ],
        include_dirs=[
            pybind11.get_include(),
            np.get_include()
            # REMOVED "acm_engine" here so the compiler doesn't crash looking for a missing folder
        ],
        language="c++",
        extra_compile_args=[
            "-std=c++20", 
            "-O3",          
            "-fPIC",        
            "-ffast-math",  
            "-fopenmp"      # 🚀 CRITICAL: Tells GCC to enable OpenMP parallelization
        ],
        extra_link_args=[
            "-std=c++20",
            "-fopenmp"      # 🚀 CRITICAL: Links the generated multi-threaded instructions
        ],
    ),
]

setup(
    name="acm_engine",
    version="1.0.0",
    description="High-Performance Zero-Copy SDA Engine via PyBind11",
    ext_modules=ext_modules,
    zip_safe=False,
)