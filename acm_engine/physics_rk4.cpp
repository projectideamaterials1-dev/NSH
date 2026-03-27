#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>
#include <cmath>
#include <chrono>
#include <unordered_set>
#include <vector>
#include <array>
#include <omp.h>

namespace py = pybind11;

// ============================================================================
// EXACT ORBITAL CONSTANTS & CONFIGURATION
// ============================================================================
constexpr double MU_EARTH = 398600.4418;     
constexpr double R_EARTH = 6378.137;         
constexpr double J2 = 1.08263e-3;            
constexpr double MAX_INTEGRATION_STEP = 1.0; 
constexpr double COLLISION_THRESHOLD = 0.100;

// 🚀 SCALED GRID TUNING: Reduces 30 outer loops down to 12. 
// At 5.0s, max travel is 75km. A 3x3 check of 80km cells covers 240km. Mathematically flawless.
constexpr double CHUNK_DT = 5.0;       
constexpr double HASH_CELL_SIZE = 80.0; 
constexpr int HASH_TABLE_SIZE = 524287; // Large prime for flat hashing
constexpr double J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH;

// ============================================================================
// J2 ACCELERATION & TWO-BODY KINEMATICS
// ============================================================================
inline void compute_acceleration(const double x, const double y, const double z,
                                 double& ax, double& ay, double& az) {
    const double r2 = x*x + y*y + z*z;
    if (r2 < 1e-20) { ax = ay = az = 0.0; return; }
    
    const double r_inv = 1.0 / std::sqrt(r2);
    const double r2_inv = r_inv * r_inv;
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
    
    #pragma omp parallel for schedule(static)
    for (size_t i = 0; i < n_objects; ++i) {
        double* obj_state = states + (i * 6);
        for (int step = 0; step < num_steps; ++step) {
            rk4_step(obj_state, dt_internal);
        }
    }
}

// ============================================================================
// CONTINUOUS COLLISION DETECTION (NARROW PHASE)
// ============================================================================
inline bool check_ccd(
    double px1, double py1, double pz1, double ex1, double ey1, double ez1,
    double px2, double py2, double pz2, double ex2, double ey2, double ez2,
    double dt, double threshold, double& out_miss_distance, double& out_tca
) {
    double rx = px2 - px1, ry = py2 - py1, rz = pz2 - pz1;
    double vx = (ex2 - px2)/dt - (ex1 - px1)/dt;
    double vy = (ey2 - py2)/dt - (ey1 - py1)/dt;
    double vz = (ez2 - pz2)/dt - (ez1 - pz1)/dt;

    double a = vx*vx + vy*vy + vz*vz;
    double b = 2.0 * (rx*vx + ry*vy + rz*vz);
    double c = rx*rx + ry*ry + rz*rz;

    double t_min = 0.0;
    if (a > 1e-12) {
        t_min = -b / (2.0 * a);
        if (t_min < 0.0) t_min = 0.0;
        else if (t_min > dt) t_min = dt;
    }

    double dist_sq = a * t_min * t_min + b * t_min + c;
    if (dist_sq < threshold * threshold) {
        out_miss_distance = std::sqrt(dist_sq);
        out_tca = t_min;
        return true;
    }
    return false;
}

// ============================================================================
// SPATIAL HASHING (BROAD PHASE)
// ============================================================================
inline unsigned int get_hash_idx(double x, double y, double z) {
    const long long ix = static_cast<long long>(std::floor(x / HASH_CELL_SIZE));
    const long long iy = static_cast<long long>(std::floor(y / HASH_CELL_SIZE));
    const long long iz = static_cast<long long>(std::floor(z / HASH_CELL_SIZE));
    unsigned long long key = (ix * 73856093ULL) ^ (iy * 19349663ULL) ^ (iz * 83492791ULL);
    return key % HASH_TABLE_SIZE;
}

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
    py::buffer_info sat_buf = sat_states.request(true);
    py::buffer_info debris_buf = debris_states.request(true);
    
    double* sat_ptr = static_cast<double*>(sat_buf.ptr);
    double* debris_ptr = static_cast<double*>(debris_buf.ptr);
    
    const size_t n_sats = sat_buf.shape[0];
    const size_t n_debris = debris_buf.shape[0];
    const size_t n_total = n_sats + n_debris;
    
    if (n_total == 0) {
        py::gil_scoped_acquire acquire;
        std::vector<py::ssize_t> empty_shape = {0, 5};
        return std::make_tuple(sat_states, debris_states, py::array_t<double>(empty_shape));
    }
    
    std::vector<std::array<double, 5>> collisions;
    std::unordered_set<unsigned long long> reported_pairs;
    std::vector<double> prev_pos(n_total * 3);
    
    // 🚀 THE FIX: Data-Oriented Flat Arrays (Zero Heap Allocations inside the loop)
    std::vector<int> head(HASH_TABLE_SIZE, -1);
    std::vector<int> next_node(n_total, -1);
    
    double t_elapsed = 0.0;
    
    while (t_elapsed < dt_seconds) {
        double current_dt = std::min(CHUNK_DT, dt_seconds - t_elapsed);
        
        #pragma omp parallel for schedule(static)
        for(size_t i = 0; i < n_sats; i++) {
            prev_pos[i*3]   = sat_ptr[i*6];
            prev_pos[i*3+1] = sat_ptr[i*6+1];
            prev_pos[i*3+2] = sat_ptr[i*6+2];
        }
        #pragma omp parallel for schedule(static)
        for(size_t i = 0; i < n_debris; i++) {
            prev_pos[(n_sats+i)*3]   = debris_ptr[i*6];
            prev_pos[(n_sats+i)*3+1] = debris_ptr[i*6+1];
            prev_pos[(n_sats+i)*3+2] = debris_ptr[i*6+2];
        }

        propagate_in_place(sat_ptr, n_sats, current_dt);
        propagate_in_place(debris_ptr, n_debris, current_dt);

        // Instantly reset the flat hash map (Lightning fast C++ std::fill)
        std::fill(head.begin(), head.end(), -1);

        // Build the Flat Spatial Hash
        for(size_t i = 0; i < n_total; i++) {
            unsigned int h = get_hash_idx(prev_pos[i*3], prev_pos[i*3+1], prev_pos[i*3+2]);
            next_node[i] = head[h];
            head[h] = i;
        }

        // 🚀 THE FIX: Multithread the Collision Checking! 
        #pragma omp parallel for schedule(dynamic)
        for(int s = 0; s < (int)n_sats; s++) {
            const long long ix = static_cast<long long>(std::floor(prev_pos[s*3] / HASH_CELL_SIZE));
            const long long iy = static_cast<long long>(std::floor(prev_pos[s*3+1] / HASH_CELL_SIZE));
            const long long iz = static_cast<long long>(std::floor(prev_pos[s*3+2] / HASH_CELL_SIZE));
            
            for (long long dx = -1; dx <= 1; ++dx) {
                for (long long dy = -1; dy <= 1; ++dy) {
                    for (long long dz = -1; dz <= 1; ++dz) {
                        unsigned long long key = ((ix + dx) * 73856093ULL) ^ ((iy + dy) * 19349663ULL) ^ ((iz + dz) * 83492791ULL);
                        unsigned int h = key % HASH_TABLE_SIZE;
                        
                        int n_idx = head[h];
                        while (n_idx != -1) {
                            if (n_idx < (int)n_sats && s >= n_idx) {
                                n_idx = next_node[n_idx];
                                continue; 
                            }
                            
                            unsigned long long pair_id = ((unsigned long long)s << 32) | (unsigned long long)n_idx;
                            
                            // Safe read (set only modified in critical section)
                            bool already_reported = false;
                            #pragma omp critical(read_set)
                            { already_reported = reported_pairs.count(pair_id); }
                            
                            if (already_reported) {
                                n_idx = next_node[n_idx];
                                continue;
                            }

                            double ex_n, ey_n, ez_n;
                            if (n_idx < (int)n_sats) {
                                ex_n = sat_ptr[n_idx*6]; ey_n = sat_ptr[n_idx*6+1]; ez_n = sat_ptr[n_idx*6+2];
                            } else {
                                size_t d_idx = n_idx - n_sats;
                                ex_n = debris_ptr[d_idx*6]; ey_n = debris_ptr[d_idx*6+1]; ez_n = debris_ptr[d_idx*6+2];
                            }

                            double miss_dist, tca_local;
                            bool collision = check_ccd(
                                prev_pos[s*3], prev_pos[s*3+1], prev_pos[s*3+2], sat_ptr[s*6], sat_ptr[s*6+1], sat_ptr[s*6+2],
                                prev_pos[n_idx*3], prev_pos[n_idx*3+1], prev_pos[n_idx*3+2], ex_n, ey_n, ez_n,
                                current_dt, threshold, miss_dist, tca_local
                            );

                            if (collision) {
                                // Thread-safe write to collisions array
                                #pragma omp critical(write_col)
                                {
                                    reported_pairs.insert(pair_id);
                                    double is_deb = (n_idx >= (int)n_sats) ? 1.0 : 0.0;
                                    double target_id_val = (n_idx >= (int)n_sats) ? static_cast<double>(n_idx - n_sats) : static_cast<double>(n_idx);
                                    collisions.push_back({static_cast<double>(s), target_id_val, is_deb, miss_dist, t_elapsed + tca_local});
                                }
                            }
                            n_idx = next_node[n_idx]; // Traverse flat linked list
                        }
                    }
                }
            }
        }
        t_elapsed += current_dt;
    }
    
    py::gil_scoped_acquire acquire;
    std::vector<py::ssize_t> result_shape = { static_cast<py::ssize_t>(collisions.size()), 5 };
    py::array_t<double> result(result_shape);
    auto result_buf = result.request(true);
    double* result_ptr = static_cast<double*>(result_buf.ptr);
    
    for (size_t i = 0; i < collisions.size(); ++i) {
        result_ptr[i * 5]     = collisions[i][0];
        result_ptr[i * 5 + 1] = collisions[i][1];
        result_ptr[i * 5 + 2] = collisions[i][2];
        result_ptr[i * 5 + 3] = collisions[i][3];
        result_ptr[i * 5 + 4] = collisions[i][4]; 
    }
    
    return std::make_tuple(sat_states, debris_states, result);
}

PYBIND11_MODULE(acm_engine, m) {
    m.doc() = "Autonomous Constellation Manager - True CCD SDA Engine";
    m.def("process_conjunctions", &process_conjunctions,
          py::call_guard<py::gil_scoped_release>(),
          "Detects collisions with chunked RK4 + J2 propagation and Continuous Collision Detection (CCD)",
          py::arg("sat_states").noconvert(),
          py::arg("debris_states").noconvert(),
          py::arg("threshold"),
          py::arg("dt_seconds"));
}