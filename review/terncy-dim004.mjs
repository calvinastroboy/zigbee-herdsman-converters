// Experimental review build. DIM004 private commands require hardware validation.
// DIM004 app range: 100–1000 mA, step 10. Must match the LED load rating.
import {Zcl} from "zigbee-herdsman";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import * as m from "zigbee-herdsman-converters/lib/modernExtend";

const e = exposes.presets;
const ea = exposes.access;
const XIAOYAN_MANUFACTURER_CODE = 0x1228;
const TERNCY_DIMMER_POWER_CLUSTER = "terncyDimmerPower";
const TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER = "terncyDimmerLightEffect";
const terncyManufacturerOptions = {manufacturerCode: XIAOYAN_MANUFACTURER_CODE};
const DIM003_DEFAULT_MIN_KELVIN = 1600;
const DIM003_DEFAULT_MAX_KELVIN = 7000;
const DIM003_POWER_CALIBRATION_MODE_RATED_MAX_CURRENT = 0x00;
const DIM003_LIGHT_UP_CURVE = {
    fast_start: 0,
    uniform: 1,
    slow_start: 2,
};
const DIM003_LIGHT_UP_CURVE_BY_VALUE = {
    0: "fast_start",
    1: "uniform",
    2: "slow_start",
};
function lookupNumber(value, key, lookup) {
    const name = String(value);
    if (!Object.hasOwn(lookup, name)) {
        throw new Error(`${key} must be one of: ${Object.keys(lookup).join(", ")}`);
    }
    return {name: name, value: lookup[name]};
}
function numberInRange(value, key, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}`);
    }
    return Math.round(number);
}
function stateNumber(meta, key, fallback) {
    const value = Number(meta.state?.[key]);
    return Number.isFinite(value) ? value : fallback;
}
function kelvinToMired(kelvin) {
    return Math.round(1000000 / kelvin);
}
function booleanValue(value, key) {
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = String(value).toLowerCase();
    if (["true", "on", "1"].includes(normalized)) {
        return true;
    }
    if (["false", "off", "0"].includes(normalized)) {
        return false;
    }
    throw new Error(`${key} must be true or false`);
}
async function sendDim003PowerCommand(entity, payload) {
    await entity.command(TERNCY_DIMMER_POWER_CLUSTER, "powerCalibration", payload, {...terncyManufacturerOptions, disableDefaultResponse: false});
}
async function sendDim003AdjustStartLevel(entity, payload) {
    await entity.command(TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER, "adjustStartLevel", payload, {
        ...terncyManufacturerOptions,
        disableDefaultResponse: false,
    });
}
async function sendDim003ColorTempRange(entity, payload) {
    await entity.command(TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER, "setColorTempRange", payload, {
        ...terncyManufacturerOptions,
        disableDefaultResponse: false,
    });
}
function strictDim004Numeric(converter) {
    return {
        ...converter,
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== "number" || !Number.isInteger(value)) {
                throw new Error(`${key} must be an integer number`);
            }
            if (key.startsWith("color_temperature_range_")) {
                const minKey = "color_temperature_range_min_kelvin";
                const maxKey = "color_temperature_range_max_kelvin";
                const min = key === minKey ? value : meta.state?.[minKey] === undefined ? DIM003_DEFAULT_MIN_KELVIN : meta.state[minKey];
                const max = key === maxKey ? value : meta.state?.[maxKey] === undefined ? DIM003_DEFAULT_MAX_KELVIN : meta.state[maxKey];
                if (
                    typeof min !== "number" ||
                    typeof max !== "number" ||
                    !Number.isInteger(min) ||
                    !Number.isInteger(max) ||
                    min < 1000 ||
                    min > 10000 ||
                    max < 1000 ||
                    max > 10000
                ) {
                    throw new Error("Color temperature limits must be integer numbers from 1000 to 10000 K");
                }
                if (min >= max || kelvinToMired(max) >= kelvinToMired(min)) {
                    throw new Error("Color temperature limits must remain distinct and ordered after conversion to mired");
                }
            }
            return await converter.convertSet(entity, key, value, meta);
        },
    };
}
const terncyExtend = {
    addDimmerPowerCluster: () =>
        m.deviceAddCustomCluster(TERNCY_DIMMER_POWER_CLUSTER, {
            name: TERNCY_DIMMER_POWER_CLUSTER,
            ID: 0xfccc,
            manufacturerCode: XIAOYAN_MANUFACTURER_CODE,
            attributes: {},
            commands: {
                powerCalibration: {
                    name: "powerCalibration",
                    ID: 0x08,
                    parameters: [
                        {name: "mode", type: Zcl.DataType.UINT8},
                        {name: "current", type: Zcl.DataType.UINT32},
                        {name: "reserved", type: Zcl.DataType.UINT32},
                    ],
                },
            },
            commandsResponse: {},
        }),
    addDimmerLightEffectCluster: () =>
        m.deviceAddCustomCluster(TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER, {
            name: TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER,
            ID: 0xfccd,
            manufacturerCode: XIAOYAN_MANUFACTURER_CODE,
            attributes: {
                xyPwmLowFrequency: {name: "xyPwmLowFrequency", ID: 0x0002, type: Zcl.DataType.UINT16},
                xyRevertColorTempGpio: {name: "xyRevertColorTempGpio", ID: 0x0005, type: Zcl.DataType.BOOLEAN, write: true},
                xyLightUpCurve: {name: "xyLightUpCurve", ID: 0x0007, type: Zcl.DataType.UINT8, write: true},
                mappedXyLevel: {name: "mappedXyLevel", ID: 0x0009, type: Zcl.DataType.UINT16},
            },
            commands: {
                adjustStartLevel: {name: "adjustStartLevel", ID: 0x00, parameters: [{name: "level", type: Zcl.DataType.UINT32}]},
                setColorTempRange: {
                    name: "setColorTempRange",
                    ID: 0x03,
                    parameters: [
                        {name: "min", type: Zcl.DataType.UINT16},
                        {name: "max", type: Zcl.DataType.UINT16},
                    ],
                },
                setBezier: {
                    name: "setBezier",
                    ID: 0x05,
                    parameters: [
                        {name: "type", type: Zcl.DataType.UINT8},
                        {name: "x1", type: Zcl.DataType.UINT16},
                        {name: "y1", type: Zcl.DataType.UINT16},
                        {name: "x2", type: Zcl.DataType.UINT16},
                        {name: "y2", type: Zcl.DataType.UINT16},
                        {name: "x3", type: Zcl.DataType.UINT16},
                        {name: "y3", type: Zcl.DataType.UINT16},
                    ],
                },
            },
            commandsResponse: {},
        }),
};
const fzLocal = {
    dim003_light_effect_attributes: {
        cluster: TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER,
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const curve = DIM003_LIGHT_UP_CURVE_BY_VALUE[msg.data.xyLightUpCurve];
            if (curve === undefined) {
                return;
            }
            return {light_up_curve: curve};
        },
    },
};
const tzLocal = {
    dim004_rated_max_current: {
        key: ["rated_max_current_ma"],
        convertSet: async (entity, key, value, meta) => {
            // Official app SetMaxCurrentPage range, not a wattage-ratio calculation.
            // The connected LED load may require a lower limit than the driver's maximum.
            if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 1000 || value % 10 !== 0) {
                throw new Error(`${key} must be 100–1000 mA in 10 mA steps and match the LED load rating`);
            }
            await sendDim003PowerCommand(entity, {
                mode: DIM003_POWER_CALIBRATION_MODE_RATED_MAX_CURRENT,
                current: value,
                reserved: 0,
            });
            return {state: {[key]: value}};
        },
    },
    dim003_startup_depth_calibration: {
        key: ["startup_depth_calibration"],
        convertSet: async (entity, key, value, meta) => {
            const level = numberInRange(value, key, 0, 5000);
            await sendDim003AdjustStartLevel(entity, {level});
            return {state: {[key]: level}};
        },
    },
    dim003_color_temperature_range: {
        key: ["color_temperature_range_min_kelvin", "color_temperature_range_max_kelvin"],
        convertSet: async (entity, key, value, meta) => {
            const nextValue = numberInRange(value, key, 1000, 10000);
            const minKelvin =
                key === "color_temperature_range_min_kelvin"
                    ? nextValue
                    : stateNumber(meta, "color_temperature_range_min_kelvin", DIM003_DEFAULT_MIN_KELVIN);
            const maxKelvin =
                key === "color_temperature_range_max_kelvin"
                    ? nextValue
                    : stateNumber(meta, "color_temperature_range_max_kelvin", DIM003_DEFAULT_MAX_KELVIN);
            if (minKelvin >= maxKelvin) {
                throw new Error("color_temperature_range_min_kelvin must be lower than color_temperature_range_max_kelvin");
            }
            await sendDim003ColorTempRange(entity, {
                min: kelvinToMired(maxKelvin),
                max: kelvinToMired(minKelvin),
            });
            return {
                state: {
                    color_temperature_range_min_kelvin: minKelvin,
                    color_temperature_range_max_kelvin: maxKelvin,
                },
            };
        },
    },
    dim003_color_temperature_io_reversed: {
        key: ["color_temperature_io_reversed"],
        convertSet: async (entity, key, value, meta) => {
            const reversed = booleanValue(value, key);
            await entity.write(
                TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER,
                {xyRevertColorTempGpio: reversed},
                {...terncyManufacturerOptions, disableDefaultResponse: false},
            );
            return {state: {[key]: reversed}};
        },
    },
    dim003_light_up_curve: {
        key: ["light_up_curve"],
        convertSet: async (entity, key, value, meta) => {
            const curve = lookupNumber(value, key, DIM003_LIGHT_UP_CURVE);
            await entity.write(
                TERNCY_DIMMER_LIGHT_EFFECT_CLUSTER,
                {xyLightUpCurve: curve.value},
                {...terncyManufacturerOptions, disableDefaultResponse: false},
            );
            return {state: {[key]: curve.name}};
        },
    },
};
export default {
    // Review profile: confirm the fingerprint and DIM003-derived color temperature range on DIM004 hardware before submission.
    fingerprint: [{modelID: "DIM004", manufacturerName: "Xiaoyan"}],
    model: "DIM004",
    vendor: "TERNCY",
    description: "24W Jingwei color temperature dimmer",
    // Experimental DIM003-compatible controls; hardware validation is still required.
    // Never scale current by 24/100: output voltage and DIM004 driver limits are unknown.
    // Current uses the official app range; configure sends no proprietary commands.
    fromZigbee: [fzLocal.dim003_light_effect_attributes],
    toZigbee: [
        tzLocal.dim004_rated_max_current,
        strictDim004Numeric(tzLocal.dim003_startup_depth_calibration),
        strictDim004Numeric(tzLocal.dim003_color_temperature_range),
        tzLocal.dim003_color_temperature_io_reversed,
        tzLocal.dim003_light_up_curve,
    ],
    exposes: [
        e
            .numeric("rated_max_current_ma", ea.STATE_SET)
            .withUnit("mA")
            .withDescription("Maximum current limit from the DIM004 app range; must match the LED load rating, not just its power")
            .withValueMin(100)
            .withValueMax(1000)
            .withValueStep(10)
            .withCategory("config"),
        e
            .numeric("startup_depth_calibration", ea.STATE_SET)
            .withDescription("Xiaoyan startup depth calibration")
            .withValueMin(0)
            .withValueMax(5000)
            .withValueStep(1)
            .withCategory("config"),
        e
            .numeric("color_temperature_range_min_kelvin", ea.STATE_SET)
            .withUnit("K")
            .withDescription("Warmest color temperature limit")
            .withValueMin(1000)
            .withValueMax(10000)
            .withValueStep(1)
            .withCategory("config"),
        e
            .numeric("color_temperature_range_max_kelvin", ea.STATE_SET)
            .withUnit("K")
            .withDescription("Coolest color temperature limit")
            .withValueMin(1000)
            .withValueMax(10000)
            .withValueStep(1)
            .withCategory("config"),
        e
            .binary("color_temperature_io_reversed", ea.STATE_SET, true, false)
            .withDescription("Reverse the cool and warm white output IO mapping")
            .withCategory("config"),
        exposes
            .enum("light_up_curve", ea.STATE_SET, Object.keys(DIM003_LIGHT_UP_CURVE))
            .withDescription("Light-up curve; requires DIM004 firmware version 208 or newer")
            .withCategory("config"),
    ],
    extend: [
        terncyExtend.addDimmerPowerCluster(),
        terncyExtend.addDimmerLightEffectCluster(),
        m.light({
            colorTemp: {range: [142, 625], startup: false},
            configureReporting: true,
            effect: false,
            powerOnBehavior: false,
        }),
    ],
};
