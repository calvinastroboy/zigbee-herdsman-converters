import {describe, expect, it} from "vitest";
import {definitions} from "../src/devices/terncy";
import {findByDevice, prepareDefinition} from "../src/index";
import type {Definition, Fz, Tz} from "../src/lib/types";
import {assertArray} from "../src/lib/utils";
import {mockDevice} from "./utils";

function getDefinition(model: string): Definition {
    const definition = definitions.find((candidate) => candidate.model === model);
    if (!definition) throw new Error(`Missing Terncy definition for ${model}`);
    return prepareDefinition(definition);
}

// Synthetic fixtures test the proposed profile, not hardware compatibility.
function dimmer(modelID: string, manufacturerName = "Xiaoyan") {
    return mockDevice({
        modelID,
        manufacturerName,
        endpoints: [{ID: 1, inputClusters: ["genBasic", "genOnOff", "genLevelCtrl", "lightingColorCtrl"]}],
    });
}

describe("Terncy DIM004 review profile", () => {
    it("matches DIM004 separately from DIM003 and requires the manufacturer", async () => {
        expect((await findByDevice(dimmer("DIM004")))?.model).toBe("DIM004");
        expect((await findByDevice(dimmer("DIM003")))?.model).toBe("DIM003");
        expect((await findByDevice(dimmer("DIM004", "Other")))?.model).not.toBe("DIM004");
    });

    it("adds DIM003 light configuration with DIM004-specific current limits", () => {
        const definition = getDefinition("DIM004");
        assertArray(definition.exposes);
        expect(definition.exposes).toHaveLength(7);
        for (const key of [
            "startup_depth_calibration",
            "color_temperature_range_min_kelvin",
            "color_temperature_range_max_kelvin",
            "color_temperature_io_reversed",
            "light_up_curve",
        ]) {
            expect(definition.toZigbee.some((converter) => converter.key?.includes(key))).toBe(true);
        }
        const light = definition.exposes.find((expose) => expose.type === "light");
        expect(light.type).toBe("light");
        expect(light.features.map((feature) => feature.property)).toEqual(["state", "brightness", "color_temp"]);
        // Inherited DIM003 range for review; this is not a DIM004 hardware measurement.
        expect(light.features.find((feature) => feature.property === "color_temp")).toMatchObject({
            value_min: 142,
            value_max: 625,
        });
        for (const key of ["color_temp_startup", "effect", "power_on_behavior"]) {
            expect(definition.toZigbee.some((converter) => converter.key?.includes(key))).toBe(false);
        }
    });

    it.each([
        ["genOnOff", {onOff: 1}, {state: "ON"}],
        ["genLevelCtrl", {currentLevel: 128}, {brightness: 128}],
        ["lightingColorCtrl", {colorTemperature: 300}, {color_temp: 300}],
    ])("decodes %s reports through the standard converters", (cluster, data, expected) => {
        const definition = getDefinition("DIM004");
        const device = dimmer("DIM004");
        const converter = definition.fromZigbee.find((candidate) => candidate.cluster === cluster && candidate.type.includes("attributeReport"));
        expect(converter).toBeDefined();
        const result = converter.convert(
            definition,
            {
                data,
                type: "attributeReport",
                cluster,
                endpoint: device.getEndpoint(1),
                device,
                meta: {rawData: Buffer.alloc(0)},
                groupID: 0,
                linkquality: 100,
            } as Fz.Message<"genOnOff" | "genLevelCtrl" | "lightingColorCtrl", undefined, "attributeReport">,
            () => {},
            {},
            {device, state: {}, deviceExposesChanged: () => {}},
        );
        expect(result).toMatchObject(expected);
    });

    it("configures standard reporting without proprietary writes", async () => {
        const device = dimmer("DIM004");
        const endpoint = device.getEndpoint(1);
        const coordinator = dimmer("coordinator").getEndpoint(1);
        const definition = getDefinition("DIM004");
        await definition.configure(device, coordinator, definition);

        for (const cluster of ["genOnOff", "genLevelCtrl", "lightingColorCtrl"]) {
            expect(endpoint.bind).toHaveBeenCalledWith(cluster, coordinator);
            expect(endpoint.configureReporting).toHaveBeenCalledWith(cluster, expect.any(Array));
        }
        expect(endpoint.command).not.toHaveBeenCalled();
        expect(endpoint.write).not.toHaveBeenCalled();
    });

    it("limits DIM004 current to the official app range, without writing a default", async () => {
        const definition = getDefinition("DIM004");
        assertArray(definition.exposes);
        expect(definition.exposes.find((expose) => expose.property === "rated_max_current_ma")).toMatchObject({
            value_min: 100,
            value_max: 1000,
            value_step: 10,
        });
        const device = dimmer("DIM004");
        const endpoint = device.getEndpoint(1);
        const converter = definition.toZigbee.find((candidate) => candidate.key?.includes("rated_max_current_ma"));
        expect(converter).toBeDefined();
        const meta = {state: {}, device, mapped: definition} as Parameters<NonNullable<Tz.Converter["convertSet"]>>[3];
        for (const value of [100, 1000]) {
            await converter.convertSet(endpoint, "rated_max_current_ma", value, meta);
            expect(endpoint.command).toHaveBeenLastCalledWith(
                "terncyDimmerPower",
                "powerCalibration",
                {mode: 0, current: value, reserved: 0},
                {manufacturerCode: 0x1228, disableDefaultResponse: false},
            );
        }
        endpoint.command.mockClear();
        for (const value of [99, 1001, 1188, 4950, 105, 100.1, Number.NaN, "", null, true]) {
            await expect(converter.convertSet(endpoint, "rated_max_current_ma", value, meta)).rejects.toThrow();
        }
        expect(endpoint.command).not.toHaveBeenCalled();
        expect(endpoint.write).not.toHaveBeenCalled();
    });

    it.each([
        ["startup_depth_calibration", 200, "command", "adjustStartLevel", {level: 200}],
        ["color_temperature_range_min_kelvin", 2000, "command", "setColorTempRange", {min: 143, max: 500}],
        ["color_temperature_io_reversed", true, "write", undefined, {xyRevertColorTempGpio: true}],
        ["light_up_curve", "slow_start", "write", undefined, {xyLightUpCurve: 2}],
    ])("encodes %s using the DIM003 protocol without scaling non-power values", async (key, value, operation, command, payload) => {
        const definition = getDefinition("DIM004");
        const device = dimmer("DIM004");
        const endpoint = device.getEndpoint(1);
        const converter = definition.toZigbee.find((candidate) => candidate.key?.includes(key));
        const meta = {state: {}, device, mapped: definition} as Parameters<NonNullable<Tz.Converter["convertSet"]>>[3];
        await converter.convertSet(endpoint, key, value, meta);
        const options = {manufacturerCode: 0x1228, disableDefaultResponse: false};
        if (operation === "command") {
            expect(endpoint.command).toHaveBeenCalledWith("terncyDimmerLightEffect", command, payload, options);
            expect(endpoint.write).not.toHaveBeenCalled();
        } else {
            expect(endpoint.write).toHaveBeenCalledWith("terncyDimmerLightEffect", payload, options);
            expect(endpoint.command).not.toHaveBeenCalled();
        }
    });

    it.each([
        ["startup_depth_calibration", -1],
        ["startup_depth_calibration", 5001],
        ["color_temperature_range_min_kelvin", 8000],
        ["color_temperature_range_max_kelvin", 1500],
        ["color_temperature_io_reversed", "invalid"],
        ["light_up_curve", "invalid"],
    ])("rejects invalid %s before any device write", async (key, value) => {
        const definition = getDefinition("DIM004");
        const device = dimmer("DIM004");
        const endpoint = device.getEndpoint(1);
        const converter = definition.toZigbee.find((candidate) => candidate.key?.includes(key as string));
        const meta = {state: {}, device, mapped: definition} as Parameters<NonNullable<Tz.Converter["convertSet"]>>[3];
        await expect(converter.convertSet(endpoint, key as string, value, meta)).rejects.toThrow();
        expect(endpoint.command).not.toHaveBeenCalled();
        expect(endpoint.write).not.toHaveBeenCalled();
    });

    it("rejects coerced numeric inputs and invalid cached temperature limits without writing", async () => {
        const definition = getDefinition("DIM004");
        const device = dimmer("DIM004");
        const endpoint = device.getEndpoint(1);
        for (const key of ["startup_depth_calibration", "color_temperature_range_min_kelvin"]) {
            const converter = definition.toZigbee.find((candidate) => candidate.key?.includes(key));
            for (const value of [null, "", false, true, [], 0.2]) {
                const meta = {state: {}, device, mapped: definition} as Parameters<NonNullable<Tz.Converter["convertSet"]>>[3];
                await expect(converter.convertSet(endpoint, key, value, meta)).rejects.toThrow();
            }
        }
        const converter = definition.toZigbee.find((candidate) => candidate.key?.includes("color_temperature_range_max_kelvin"));
        for (const value of [null, 0, Number.POSITIVE_INFINITY, "", false]) {
            const meta = {state: {color_temperature_range_min_kelvin: value}, device, mapped: definition} as Parameters<
                NonNullable<Tz.Converter["convertSet"]>
            >[3];
            await expect(converter.convertSet(endpoint, "color_temperature_range_max_kelvin", 7000, meta)).rejects.toThrow();
        }
        expect(endpoint.command).not.toHaveBeenCalled();
        expect(endpoint.write).not.toHaveBeenCalled();
    });

    it("preserves DIM003's existing proprietary controls", () => {
        const definition = getDefinition("DIM003");
        assertArray(definition.exposes);
        expect(definition.exposes.find((expose) => expose.property === "rated_max_current_ma")).toMatchObject({value_min: 120, value_max: 4950});
        expect(definition.toZigbee.some((converter) => converter.key?.includes("rated_max_current_ma"))).toBe(true);
        expect(definition.toZigbee.some((converter) => converter.key?.includes("light_up_curve"))).toBe(true);
    });
});
