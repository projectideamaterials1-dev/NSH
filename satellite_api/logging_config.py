import logging
import sys
from pythonjsonlogger import jsonlogger

def setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    formatter = jsonlogger.JsonFormatter(
        '%(asctime)s %(levelname)s %(name)s %(message)s'
    )
    handler.setFormatter(formatter)
    
    root_logger = logging.getLogger()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)
    
    # Suppress verbose logs
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
