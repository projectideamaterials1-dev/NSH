import logging
import os
import sys
from pythonjsonlogger import jsonlogger

def setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    formatter = jsonlogger.JsonFormatter(
        '%(asctime)s %(levelname)s %(name)s %(message)s'
    )
    handler.setFormatter(formatter)
    
    root_logger = logging.getLogger()
    # Avoid stacking duplicate handlers if setup runs more than once
    root_logger.handlers = [h for h in root_logger.handlers if not getattr(h, "_acm_handler", False)]
    handler._acm_handler = True
    root_logger.addHandler(handler)
    root_logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
    
    # Suppress verbose logs
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
