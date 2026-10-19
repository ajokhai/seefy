import os

# Tests don't start the real WiFi reader (a compiled Swift helper on macOS).
os.environ.setdefault("SEEFY_WIFI", "off")
