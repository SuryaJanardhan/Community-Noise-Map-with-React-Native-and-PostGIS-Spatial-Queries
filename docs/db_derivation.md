# Decibel Derivation Methodology

## Why microphone dBFS is different from SPL

The metering value exposed by phone recording APIs is usually in **dBFS** (decibels relative to digital full scale), which describes signal level inside the device audio pipeline. Environmental noise reporting expects **SPL** (sound pressure level in dB), which is a calibrated physical measurement in air. Because dBFS depends on hardware gain, microphone sensitivity, and software processing, it cannot be treated as SPL directly.

## Chosen calibration formula

For this project, the app uses:

**SPL ≈ dBFS + 95**

So the selected calibration offset is **95 dB**.

## Rationale for using offset 95

A 95 dB offset keeps typical ambient smartphone metering values (often around -60 dBFS to -20 dBFS) within a practical urban SPL range (~35 dB to ~75 dB). This gives realistic relative hotspot mapping for crowdsourced visualization while keeping implementation simple. The value is still an approximation because accurate SPL requires per-device calibration against a known reference sound source.
