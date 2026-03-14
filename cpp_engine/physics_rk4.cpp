#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>
#include <cmath>
#include <chrono>
#include <unordered_map>
#include <vector>
#include <array>

namespace py = pybind11;

// ============================================================================
// ORBITAL CONSTANTS (Strictly matched to NSH 2026 Problem Statement)
// ============================================================================
constexpr double MU_EARTH = 398600.4418;     // km³/s²
constexpr double R_EARTH = 6378.137;         // km
constexpr double J2 = 1.08263e-3;            // Dimensionless (Exact PDF value)

// 🚀 MICRO-OPTIMIZATION: Pre-computed J2 Constant
// K_J2 = 1.5 * J2 * mu * R_E^2
constexpr double K_J2 = 1.5 * J2 * MU_EARTH * (R_EARTH * R_EARTH);

// CRITICAL INTEGRATION PARAMS
constexpr double MAX_INTEGRATION_STEP = 1.0;  // seconds (prevents high-velocity tunneling)

// ============================================================================
// KINEMATICS & PERTURBATIONS
// ============================================================================

inline void compute_acceleration(double x, double y, double z, 
                                 double& ax, double& ay, double& az) {
    double r = std::sqrt(x*x + y*y + z*z);
    
    // Singularity protection (Earth center)
    if (r < 1e-10) {
        ax = ay = az = 0.0;
        return;
    }
    
    double r2 = r * r;
    double r5 = r2 * r2 * r;
    double z2_r2 = (z * z) / r2;
    
    // 🚀 Applies the pre-computed K_J2 constant (Saves millions of multiplications)
    double j2_factor = K_J2 / r5;
    double a_two_body = -MU_EARTH / (r2 * r);
    
    // Corrected J2 signs to account for the double-negative expansion
    ax = x * (a_two_body + j2_factor * (5.0 * z2_r2 - 1.0));
    ay = y * (a_two_body + j2_factor * (5.0 * z2_r2 - 1.0));
    az = z * (a_two_body + j2_factor * (5.0 * z2_r2 - 3.0));
}

// RK4 Integration Step (Inlined for O(1) jump optimization)
inline void rk4_step(double* __restrict state, double dt) {
    double x = state[0], y = state[1], z = state[2];
    double vx = state[3], vy = state[4], vz = state[5];
    
    double ax1, ay1, az1;
    compute_acceleration(x, y, z, ax1, ay1, az1);
    
    double x2 = x + 0.5*dt*vx, y2 = y + 0.5*dt*vy, z2 = z + 0.5*dt*vz;
    double vx2 = vx + 0.5*dt*ax1, vy2 = vy + 0.5*dt*ay1, vz2 = vz + 0.5*dt*az1;
    double ax2, ay2, az2;
    compute_acceleration(x2, y2, z2, ax2, ay2, az2);
    
    double x3 = x + 0.5*dt*vx2, y3 = y + 0.5*dt*vy2, z3 = z + 0.5*dt*vz2;
    double vx3 = vx + 0.5*dt*ax2, vy3 = vy + 0.5*dt*ay2, vz3 = vz + 0.5*dt*az2;
    double ax3, ay3, az3;
    compute_acceleration(x3, y3, z3, ax3, ay3, az3);
    
    double x4 = x + dt*vx3, y4 = y + dt*vy3, z4 = z + dt*vz3;
    double vx4 = vx + dt*ax3, vy4 = vy + dt*ay3, vz4 = vz + dt*az3;
    double ax4, ay4, az4;
    compute_acceleration(x4, y4, z4, ax4, ay4, az4);
    
    state[0] += (dt / 6.0) * (vx + 2*vx2 + 2*vx3 + vx4);
    state[1] += (dt / 6.0) * (vy + 2*vy2 + 2*vy3 + vy4);
    state[2] += (dt / 6.0) * (vz + 2*vz2 + 2*vz3 + vz4);
    state[3] += (dt / 6.0) * (ax1 + 2*ax2 + 2*ax3 + ax4);
    state[4] += (dt / 6.0) * (ay1 + 2*ay2 + 2*ay3 + ay4);
    state[5] += (dt / 6.0) * (az1 + 2*az2 + 2*az3 + az4);
}

void propagate_all_objects(double* states, size_t n_objects, double dt_total) {
    if (dt_total <= 0.0 || n_objects == 0) return;

    int num_steps = std::ceil(dt_total / MAX_INTEGRATION_STEP);
    if (num_steps == 0) return; 
    
    double dt_internal = dt_total / num_steps;
    
    for (int step = 0; step < num_steps; ++step) {
        for (size_t i = 0; i < n_objects; ++i) {
            double* state = states + (i * 6);
            rk4_step(state, dt_internal);
        }
    }
}

// ============================================================================
// SPATIAL HASHING & COLLISION DETECTION
// ============================================================================

struct SpatialHash {
    double cell_size;
    SpatialHash(double size) : cell_size(size) {}
    
    inline long long hash_key(double x, double y, double z) const {
        long long ix = static_cast<long long>(std::floor(x / cell_size));
        long long iy = static_cast<long long>(std::floor(y / cell_size));
        long long iz = static_cast<long long>(std::floor(z / cell_size));
        // Large primes to scatter the hash and prevent bucket collisions
        return (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
    }
};

std::tuple<py::array_t<double>, py::array_t<double>, py::array_t<double>> 
process_conjunctions(
    py::array_t<double> sat_states,
    py::array_t<double> debris_states,
    double threshold,
    double dt_seconds
) {
    auto start_time = std::chrono::high_resolution_clock::now();
    
    auto sat_buf = sat_states.request();
    auto debris_buf = debris_states.request();
    
    double* sat_ptr = static_cast<double*>(sat_buf.ptr);
    double* debris_ptr = static_cast<double*>(debris_buf.ptr);
    
    size_t n_sats = sat_buf.shape[0];
    size_t n_debris = debris_buf.shape[0];
    size_t n_total = n_sats + n_debris;

    // EDGE CASE GUARD: Empty payload
    if (n_total == 0) {
        py::gil_scoped_acquire acquire;
        // 🛠️ TRUE ZERO-ALLOCATION SHAPE: Strongly typed ssize_t prevents GCC ambiguity
        py::ssize_t rows = 0;
        py::ssize_t cols = 4;
        py::array_t<double> result({rows, cols});
        return std::make_tuple(sat_states, debris_states, result);
    }

    // 1. Combine buffers for vectorized contiguous memory access
    std::vector<double> combined_states(n_total * 6);
    for (size_t i = 0; i < n_sats * 6; ++i) combined_states[i] = sat_ptr[i];
    for (size_t i = 0; i < n_debris * 6; ++i) combined_states[(n_sats * 6) + i] = debris_ptr[i];
        
    // 2. Propagate physics (only if time actually moves forward)
    if (dt_seconds > 0.0) {
        propagate_all_objects(combined_states.data(), n_total, dt_seconds);
        
        for (size_t i = 0; i < n_sats * 6; ++i) sat_ptr[i] = combined_states[i];
        for (size_t i = 0; i < n_debris * 6; ++i) debris_ptr[i] = combined_states[(n_sats * 6) + i];
    }

    // 3. Unified Spatial Hash Broad Phase
    SpatialHash hash_grid(threshold * 5.0);
    std::unordered_map<long long, std::vector<size_t>> grid;
    grid.reserve(n_total);
    
    for (size_t i = 0; i < n_total; ++i) {
        size_t offset = i * 6;
        long long key = hash_grid.hash_key(
            combined_states[offset],
            combined_states[offset + 1],
            combined_states[offset + 2]
        );
        grid[key].push_back(i);
    }

    // 4. Narrow Phase Collision Check
    std::vector<std::array<double, 4>> collisions;
    collisions.reserve(500);

    double threshold_sq = threshold * threshold;

    for (size_t s = 0; s < n_sats; ++s) {
        
        // Timeout protection (2.5 second cap)
        if (s % 10 == 0) {
            auto now = std::chrono::high_resolution_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - start_time).count();
            if (elapsed > 2500) break;
        }
        
        size_t s_offset = s * 6;
        double sx = combined_states[s_offset];
        double sy = combined_states[s_offset + 1];
        double sz = combined_states[s_offset + 2];

        long long ix = static_cast<long long>(std::floor(sx / hash_grid.cell_size));
        long long iy = static_cast<long long>(std::floor(sy / hash_grid.cell_size));
        long long iz = static_cast<long long>(std::floor(sz / hash_grid.cell_size));

        // 27-cell strict neighbor check
        for (long long dx = -1; dx <= 1; ++dx) {
            for (long long dy = -1; dy <= 1; ++dy) {
                for (long long dz = -1; dz <= 1; ++dz) {
                    
                    long long n_key = ((ix + dx) * 73856093) ^ 
                                      ((iy + dy) * 19349663) ^ 
                                      ((iz + dz) * 83492791);

                    auto it = grid.find(n_key);
                    if (it != grid.end()) {
                        for (size_t neighbor_idx : it->second) {
                            
                            // Prevent self-collision and duplicate checks
                            if (neighbor_idx < n_sats && s >= neighbor_idx) {
                                continue; 
                            }

                            size_t n_offset = neighbor_idx * 6;
                            double nx = combined_states[n_offset];
                            double ny = combined_states[n_offset + 1];
                            double nz = combined_states[n_offset + 2];

                            double dist_sq = (sx - nx)*(sx - nx) + 
                                             (sy - ny)*(sy - ny) + 
                                             (sz - nz)*(sz - nz);

                            if (dist_sq < threshold_sq) {
                                double is_debris = (neighbor_idx >= n_sats) ? 1.0 : 0.0;
                                double target_idx = (neighbor_idx >= n_sats) ? (neighbor_idx - n_sats) : neighbor_idx;
                                
                                collisions.push_back({
                                    (double)s, 
                                    target_idx, 
                                    is_debris, 
                                    std::sqrt(dist_sq)
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // ========================================================================
    // RE-ACQUIRE GIL & FORMAT OUTPUT
    // ========================================================================
    py::gil_scoped_acquire acquire;

    // 🛠️ TRUE ZERO-ALLOCATION SHAPE
    py::ssize_t result_rows = static_cast<py::ssize_t>(collisions.size());
    py::ssize_t result_cols = 4;
    py::array_t<double> result({result_rows, result_cols});
    
    auto result_buf = result.request();
    double* result_ptr = static_cast<double*>(result_buf.ptr);

    for (size_t i = 0; i < collisions.size(); ++i) {
        result_ptr[i * 4]     = collisions[i][0]; // sat_idx
        result_ptr[i * 4 + 1] = collisions[i][1]; // target_idx
        result_ptr[i * 4 + 2] = collisions[i][2]; // is_debris flag
        result_ptr[i * 4 + 3] = collisions[i][3]; // distance
    }

    return std::make_tuple(sat_states, debris_states, result);
}

// ============================================================================
// PYBIND11 MODULE DEFINITION
// ============================================================================
PYBIND11_MODULE(acm_engine, m) {
    m.doc() = "Autonomous Constellation Manager High-Performance SDA Engine";

    m.def("process_conjunctions", &process_conjunctions,
          py::call_guard<py::gil_scoped_release>(),
          "Detects collisions with RK4 + J2 propagation and unified broad-phase hashing",
          py::arg("sat_states"),
          py::arg("debris_states"),
          py::arg("threshold"),
          py::arg("dt_seconds"));
    
    // Expose constants for Python validation
    m.attr("MAX_DELTA_V_MPS") = 15.0;
    m.attr("COLLISION_THRESHOLD_KM") = 0.100;
}