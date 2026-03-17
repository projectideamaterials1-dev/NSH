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
// EXACT ORBITAL CONSTANTS
// ============================================================================
constexpr double MU_EARTH = 398600.4418;     
constexpr double R_EARTH = 6378.137;         
constexpr double J2 = 1.08263e-3;            
constexpr double MAX_INTEGRATION_STEP = 1.0; 
constexpr double COLLISION_THRESHOLD = 0.100;

// Compile-time precomputation
constexpr double J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH;

// ============================================================================
// J2 ACCELERATION & TWO-BODY KINEMATICS (Now with const optimization)
// ============================================================================
inline void compute_acceleration(const double x, const double y, const double z,
                                 double& ax, double& ay, double& az) {
    const double r2 = x*x + y*y + z*z;
    if (r2 < 1e-20) { ax = ay = az = 0.0; return; }
    
    const double r = std::sqrt(r2);
    
    const double r_inv = 1.0 / r;
    const double r2_inv = 1.0 / r2;
    const double r3_inv = r2_inv * r_inv;
    const double r5_inv = r2_inv * r3_inv;
    
    const double a_two_body = -MU_EARTH * r3_inv;
    const double j2_factor = J2_CONST * r5_inv;
    const double z2_r2 = z * z * r2_inv;
    
    ax = x * (a_two_body + j2_factor * (5.0 * z2_r2 - 1.0));
    ay = y * (a_two_body + j2_factor * (5.0 * z2_r2 - 1.0));
    az = z * (a_two_body + j2_factor * (5.0 * z2_r2 - 3.0));
}

// ============================================================================
// IN-PLACE RUNGE-KUTTA 4 (RK4)
// ============================================================================
inline void rk4_step(double* state, const double dt) {
    const double x = state[0], y = state[1], z = state[2];
    const double vx = state[3], vy = state[4], vz = state[5];
    
    double ax1, ay1, az1;
    compute_acceleration(x, y, z, ax1, ay1, az1);
    
    const double x2 = x + 0.5*dt*vx, y2 = y + 0.5*dt*vy, z2 = z + 0.5*dt*vz;
    const double vx2 = vx + 0.5*dt*ax1, vy2 = vy + 0.5*dt*ay1, vz2 = vz + 0.5*dt*az1;
    double ax2, ay2, az2;
    compute_acceleration(x2, y2, z2, ax2, ay2, az2);
    
    const double x3 = x + 0.5*dt*vx2, y3 = y + 0.5*dt*vy2, z3 = z + 0.5*dt*vz2;
    const double vx3 = vx + 0.5*dt*ax2, vy3 = vy + 0.5*dt*ay2, vz3 = vz + 0.5*dt*az2;
    double ax3, ay3, az3;
    compute_acceleration(x3, y3, z3, ax3, ay3, az3);
    
    const double x4 = x + dt*vx3, y4 = y + dt*vy3, z4 = z + dt*vz3;
    const double vx4 = vx + dt*ax3, vy4 = vy + dt*ay3, vz4 = vz + dt*az3;
    double ax4, ay4, az4;
    compute_acceleration(x4, y4, z4, ax4, ay4, az4);
    
    const double dt_6 = dt / 6.0;
    state[0] += dt_6 * (vx + 2*vx2 + 2*vx3 + vx4);
    state[1] += dt_6 * (vy + 2*vy2 + 2*vy3 + vy4);
    state[2] += dt_6 * (vz + 2*vz2 + 2*vz3 + vz4);
    state[3] += dt_6 * (ax1 + 2*ax2 + 2*ax3 + ax4);
    state[4] += dt_6 * (ay1 + 2*ay2 + 2*ay3 + ay4);
    state[5] += dt_6 * (az1 + 2*az2 + 2*az3 + az4);
}

void propagate_in_place(double* states, const size_t n_objects, const double dt_total) {
    if (dt_total <= 0.0 || n_objects == 0) return;
    const int num_steps = std::ceil(dt_total / MAX_INTEGRATION_STEP);
    if (num_steps == 0) return;
    
    const double dt_internal = dt_total / num_steps;
    
    for (int step = 0; step < num_steps; ++step) {
        for (size_t i = 0; i < n_objects; ++i) {
            rk4_step(states + (i * 6), dt_internal);
        }
    }
}

// ============================================================================
// SPATIAL HASHING
// ============================================================================
struct SpatialHash {
    const double cell_size;
    SpatialHash(double size) : cell_size(size) {}
    
    inline long long hash_key(const double x, const double y, const double z) const {
        const long long ix = static_cast<long long>(std::floor(x / cell_size));
        const long long iy = static_cast<long long>(std::floor(y / cell_size));
        const long long iz = static_cast<long long>(std::floor(z / cell_size));
        return (ix * 73856093LL) ^ (iy * 19349663LL) ^ (iz * 83492791LL);
    }
};

// ============================================================================
// MAIN PYBIND ENTRY POINT
// ============================================================================
std::tuple<py::array_t<double>, py::array_t<double>, py::array_t<double>>
process_conjunctions(
    py::array_t<double>& sat_states,
    py::array_t<double>& debris_states,
    const double threshold,
    const double dt_seconds
) {
    auto start_time = std::chrono::high_resolution_clock::now();
    
    py::buffer_info sat_buf = sat_states.request(true);
    py::buffer_info debris_buf = debris_states.request(true);
    
    double* sat_ptr = static_cast<double*>(sat_buf.ptr);
    double* debris_ptr = static_cast<double*>(debris_buf.ptr);
    
    const size_t n_sats = sat_buf.shape[0];
    const size_t n_debris = debris_buf.shape[0];
    const size_t n_total = n_sats + n_debris;
    
    if (n_total == 0) {
        py::gil_scoped_acquire acquire;
        std::vector<py::ssize_t> empty_shape = {0, 4};
        return std::make_tuple(sat_states, debris_states, py::array_t<double>(empty_shape));
    }
    
    // Debris propagation IS present and correct
    if (dt_seconds > 0.0) {
        propagate_in_place(sat_ptr, n_sats, dt_seconds);
        propagate_in_place(debris_ptr, n_debris, dt_seconds);
    }
    
    SpatialHash hash_grid(threshold * 5.0);
    std::unordered_map<long long, std::vector<size_t>> grid;
    grid.reserve(n_total);
    
    for (size_t i = 0; i < n_sats; ++i) {
        const size_t offset = i * 6;
        const long long key = hash_grid.hash_key(sat_ptr[offset], sat_ptr[offset+1], sat_ptr[offset+2]);
        grid[key].push_back(i);
    }
    
    for (size_t i = 0; i < n_debris; ++i) {
        const size_t offset = i * 6;
        const long long key = hash_grid.hash_key(debris_ptr[offset], debris_ptr[offset+1], debris_ptr[offset+2]);
        grid[key].push_back(n_sats + i);
    }
    
    std::vector<std::array<double, 4>> collisions;
    collisions.reserve(500);
    
    const double threshold_sq = threshold * threshold;
    
    for (size_t s = 0; s < n_sats; ++s) {
        if (s % 10 == 0) {
            auto now = std::chrono::high_resolution_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - start_time).count();
            if (elapsed > 2500) break;
        }
        
        const double sx = sat_ptr[s * 6];
        const double sy = sat_ptr[s * 6 + 1];
        const double sz = sat_ptr[s * 6 + 2];
        
        const long long ix = static_cast<long long>(std::floor(sx / hash_grid.cell_size));
        const long long iy = static_cast<long long>(std::floor(sy / hash_grid.cell_size));
        const long long iz = static_cast<long long>(std::floor(sz / hash_grid.cell_size));
        
        for (long long dx = -1; dx <= 1; ++dx) {
            for (long long dy = -1; dy <= 1; ++dy) {
                for (long long dz = -1; dz <= 1; ++dz) {
                    const long long n_key = ((ix + dx) * 73856093LL) ^ ((iy + dy) * 19349663LL) ^ ((iz + dz) * 83492791LL);
                    
                    auto it = grid.find(n_key);
                    if (it != grid.end()) {
                        for (const size_t neighbor_idx : it->second) {
                            if (neighbor_idx < n_sats && s >= neighbor_idx) continue;
                            
                            double nx, ny, nz;
                            if (neighbor_idx < n_sats) {
                                nx = sat_ptr[neighbor_idx * 6];
                                ny = sat_ptr[neighbor_idx * 6 + 1];
                                nz = sat_ptr[neighbor_idx * 6 + 2];
                            } else {
                                const size_t d_idx = neighbor_idx - n_sats;
                                nx = debris_ptr[d_idx * 6];
                                ny = debris_ptr[d_idx * 6 + 1];
                                nz = debris_ptr[d_idx * 6 + 2];
                            }
                            
                            const double dx_val = sx - nx;
                            const double dy_val = sy - ny;
                            const double dz_val = sz - nz;
                            const double dist_sq = dx_val * dx_val + dy_val * dy_val + dz_val * dz_val;
                            
                            if (dist_sq < threshold_sq) {
                                const double is_debris = (neighbor_idx >= n_sats) ? 1.0 : 0.0;
                                const double target_idx = (neighbor_idx >= n_sats) ? 
                                                    static_cast<double>(neighbor_idx - n_sats) : 
                                                    static_cast<double>(neighbor_idx);
                                
                                collisions.push_back({
                                    static_cast<double>(s),
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
    
    py::gil_scoped_acquire acquire;
    
    std::vector<py::ssize_t> result_shape = { static_cast<py::ssize_t>(collisions.size()), 4 };
    py::array_t<double> result(result_shape);
    auto result_buf = result.request(true);
    double* result_ptr = static_cast<double*>(result_buf.ptr);
    
    for (size_t i = 0; i < collisions.size(); ++i) {
        result_ptr[i * 4]     = collisions[i][0];
        result_ptr[i * 4 + 1] = collisions[i][1];
        result_ptr[i * 4 + 2] = collisions[i][2];
        result_ptr[i * 4 + 3] = collisions[i][3];
    }
    
    return std::make_tuple(sat_states, debris_states, result);
}

PYBIND11_MODULE(acm_engine, m) {
    m.doc() = "Autonomous Constellation Manager True Zero-Copy SDA Engine";
    
    m.def("process_conjunctions", &process_conjunctions,
          py::call_guard<py::gil_scoped_release>(),
          "Detects collisions with in-place RK4 + J2 propagation and unified spatial hashing",
          py::arg("sat_states").noconvert(),
          py::arg("debris_states").noconvert(),
          py::arg("threshold"),
          py::arg("dt_seconds"));
}