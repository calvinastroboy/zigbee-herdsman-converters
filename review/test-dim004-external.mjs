import assert from "node:assert/strict";
import test from "node:test";
import definition from "./terncy-dim004.mjs";

const cases = [
    ["rated_max_current_ma", 1000, "command", ["terncyDimmerPower", "powerCalibration", {mode: 0, current: 1000, reserved: 0}]],
    ["startup_depth_calibration", 200, "command", ["terncyDimmerLightEffect", "adjustStartLevel", {level: 200}]],
    ["color_temperature_range_min_kelvin", 2000, "command", ["terncyDimmerLightEffect", "setColorTempRange", {min: 143, max: 500}]],
    ["color_temperature_range_max_kelvin", 6500, "command", ["terncyDimmerLightEffect", "setColorTempRange", {min: 154, max: 625}]],
    ["color_temperature_io_reversed", true, "write", ["terncyDimmerLightEffect", {xyRevertColorTempGpio: true}]],
    ["light_up_curve", "slow_start", "write", ["terncyDimmerLightEffect", {xyLightUpCurve: 2}]],
];
for (const [key, value, operation, expected] of cases) {
    test(`external converter encodes ${key}`, async () => {
        const calls = [];
        const entity = {
            command: async (...args) => calls.push(["command", args]),
            write: async (...args) => calls.push(["write", args]),
        };
        const converter = definition.toZigbee.find((candidate) => candidate.key.includes(key));
        await converter.convertSet(entity, key, value, {state: {}});
        assert.deepEqual(calls, [[operation, [...expected, {manufacturerCode: 0x1228, disableDefaultResponse: false}]]]);
    });
}
test("external converter rejects unsafe current values before writing", async () => {
    const entity = {command: async () => assert.fail("must not send")};
    const converter = definition.toZigbee.find((candidate) => candidate.key.includes("rated_max_current_ma"));
    for (const value of [99, 1001, 1188, 4950, 105, "", null, true]) {
        await assert.rejects(() => converter.convertSet(entity, "rated_max_current_ma", value, {state: {}}));
    }
});
test("external converter rejects coerced calibration and invalid temperature state", async () => {
    const entity = {command: async () => assert.fail("must not send"), write: async () => assert.fail("must not write")};
    const calibration = definition.toZigbee.find((candidate) => candidate.key.includes("startup_depth_calibration"));
    for (const value of [null, "", false, true, [], 0.2]) {
        await assert.rejects(() => calibration.convertSet(entity, "startup_depth_calibration", value, {state: {}}));
    }
    const range = definition.toZigbee.find((candidate) => candidate.key.includes("color_temperature_range_min_kelvin"));
    for (const value of [null, 0, Number.POSITIVE_INFINITY, "", false]) {
        await assert.rejects(() =>
            range.convertSet(entity, "color_temperature_range_max_kelvin", 7000, {state: {color_temperature_range_min_kelvin: value}}),
        );
    }
    await assert.rejects(() =>
        range.convertSet(entity, "color_temperature_range_min_kelvin", 9999, {state: {color_temperature_range_max_kelvin: 10000}}),
    );
});
