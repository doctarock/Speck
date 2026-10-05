// Direct adaptation of ACA's rolling CalibrationTracker: confidence is
// corrected by the observed mean (reported confidence - realized reward).
export function calibrateConfidence(rawConfidence, profile, minimumSamples) {
    if (!profile || profile.samples.length < minimumSamples)
        return clamp(rawConfidence);
    return clamp(rawConfidence - profile.bias);
}
export function recordCalibration(input) {
    const reportedConfidence = clamp(input.reportedConfidence);
    const reward = clamp(input.reward);
    const sample = {
        reportedConfidence,
        reward,
        bias: reportedConfidence - reward,
        sourceObjectId: input.sourceObjectId ?? null,
        recordedAt: input.at
    };
    const samples = [...(input.current?.samples ?? []), sample].slice(-input.config.calibrationWindow);
    const bias = mean(samples.map((entry) => entry.bias));
    const meanAbsoluteError = mean(samples.map((entry) => Math.abs(entry.bias)));
    return {
        processorId: input.processorId,
        samples,
        bias,
        meanAbsoluteError,
        reliability: clamp(1 - meanAbsoluteError),
        updatedAt: input.at
    };
}
function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
function clamp(value) {
    if (!Number.isFinite(value))
        throw new TypeError("Calibration values must be finite");
    return Math.min(1, Math.max(0, value));
}
//# sourceMappingURL=calibration.js.map