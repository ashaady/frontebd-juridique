from .library import router as library_router
from .speech import router as speech_router
from .workspace import router as workspace_router

__all__ = ["library_router", "workspace_router", "speech_router"]
