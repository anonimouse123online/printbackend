const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createDemoModeGate({ enabled, authenticate, feature, allowRead = false }) {
  return (req, res, next) => {
    if (!enabled || (allowRead && SAFE_READ_METHODS.has(req.method))) return next();
    authenticate(req, res, error => {
      if (error) return next(error);
      return res.status(503).json({ error: { code: 'DEMO_MODE_UNAVAILABLE', message: `${feature} are disabled in demo mode until private storage and malware scanning are configured` } });
    });
  };
}
