import {describe, expect, it} from "vitest";
import {definitions} from "../src/devices/terncy";
import {findByDevice, prepareDefinition} from "../src/index";
import type {Definition, Fz} from "../src/lib/types";
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

    it("exposes standard brightness and color temperature only", () => {
        const definition = getDefinition("DIM004");
        assertArray(definition.exposes);
        expect(definition.exposes).toHaveLength(1);
        expect(definition.exposes[0].type).toBe("light");
        expect(definition.exposes[0].features.map((feature) => feature.property)).toEqual(["state", "brightness", "color_temp"]);
        // Inherited DIM003 range for review; this is not a DIM004 hardware measurement.
        expect(definition.exposes[0].features.find((feature) => feature.property === "color_temp")).toMatchObject({
            value_min: 142,
            value_max: 625,
        });
        for (const key of [
            "rated_max_current_ma",
            "startup_depth_calibration",
            "color_temperature_range_min_kelvin",
            "color_temperature_range_max_kelvin",
            "color_temperature_io_reversed",
            "light_up_curve",
            "color_temp_startup",
            "effect",
            "power_on_behavior",
        ]) {
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

    it("preserves DIM003's existing proprietary controls", () => {
        const definition = getDefinition("DIM003");
        assertArray(definition.exposes);
        expect(definition.exposes.find((expose) => expose.property === "rated_max_current_ma")).toMatchObject({value_min: 120, value_max: 4950});
        expect(definition.toZigbee.some((converter) => converter.key?.includes("rated_max_current_ma"))).toBe(true);
        expect(definition.toZigbee.some((converter) => converter.key?.includes("light_up_curve"))).toBe(true);
    });
});
