from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import telemetry, simulation, visualization
from state import AppState

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
app.include_router(simulation.router, prefix="/api", tags=["Simulation"])
app.include_router(visualization.router, prefix="/api", tags=["Visualization"])


@app.get("/", tags=["Health"])
def root():
    return {"status": "online", "system": "Satellite Collision Avoidance API v1.0"}