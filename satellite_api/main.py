from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from satellite_api.routers import telemetry, simulation, maneuver
from satellite_api.state import AppState

app = FastAPI(
    title="Satellite Collision Avoidance API",
    description="Real-time telemetry ingestion and orbital simulation with collision detection",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared in-memory state (replace with DB in production)
app.state.orbital_state = AppState()

app.include_router(telemetry.router, prefix="/api", tags=["Telemetry"])


app.include_router(maneuver.router, prefix="/api", tags=["Maneuver"])


app.include_router(simulation.router, prefix="/api", tags=["Simulation"])


@app.get("/", tags=["Health"])
def root():
    return {"status": "online", "system": "Satellite Collision Avoidance API v1.0"}