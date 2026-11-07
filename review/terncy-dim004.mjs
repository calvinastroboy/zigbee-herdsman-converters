// Review-only external converter. Confirm modelID/manufacturerName and the
// DIM003-derived color temperature range on DIM004 hardware before use/submission.
import * as m from "zigbee-herdsman-converters/lib/modernExtend";

export default {
    fingerprint: [{modelID: "DIM004", manufacturerName: "Xiaoyan"}],
    model: "DIM004",
    vendor: "TERNCY",
    description: "24W Jingwei color temperature dimmer",
    // No DIM003 proprietary current or calibration controls: DIM004 limits are unverified.
    extend: [
        m.light({
            colorTemp: {range: [142, 625], startup: false},
            configureReporting: true,
            effect: false,
            powerOnBehavior: false,
        }),
    ],
};
