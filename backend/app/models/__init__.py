"""SQLAlchemy ORM models. Importing this package registers all tables."""
from app.models.trading import (  # noqa: F401
    Backtest,
    BrokerAccount,
    Order,
    Position,
    RiskProfile,
    Strategy,
    StrategyInstance,
    StrategyRun,
    Trigger,
)
from app.models.platform import (  # noqa: F401
    AppSetting,
    Notification,
    NotificationPreference,
    Watchlist,
)
from app.models.user import ApiKey, MfaSecret, Role, User, UserRole  # noqa: F401

__all__ = [
    "User",
    "Role",
    "UserRole",
    "ApiKey",
    "MfaSecret",
    "BrokerAccount",
    "Order",
    "Position",
    "RiskProfile",
    "Strategy",
    "StrategyInstance",
    "StrategyRun",
    "Trigger",
    "Backtest",
    "Notification",
    "NotificationPreference",
    "Watchlist",
    "AppSetting",
]
