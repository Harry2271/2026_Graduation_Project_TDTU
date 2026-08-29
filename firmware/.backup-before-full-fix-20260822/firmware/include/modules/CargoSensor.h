#pragma once

#include <stdint.h>

/**
 * CargoSensor — microswitch (limit switch) on the cargo bed.
 *
 * Wired to a digital GPIO with internal pull-up (INPUT_PULLUP):
 *   LOW  = cargo present (NO switch pressed by package weight → GND)
 *   HIGH = cargo bed empty (NO switch open → pull-up)
 *
 * The sensor is polled every PID tick (20 ms) with a 100 ms debounce
 * filter to prevent chatter during vibration.
 *
 * Type-131 compact tick includes `cargo` field in the `st` object:
 *   true  = cargo present
 *   false = cargo bed empty
 *
 * Type-145 — on-demand cargo query:
 *   {"type":145,"data":{"present":true,"debounce_ms":1200}}
 */
class CargoSensor {
public:
    CargoSensor();

    /// Initialize GPIO as INPUT_PULLUP. Call once in setup().
    void begin();

    /// Read GPIO + apply debounce filter. Call every PID tick (20 ms).
    /// Returns true if state changed.
    bool update(uint32_t now_ms);

    /// True if cargo is currently detected (debounced).
    [[nodiscard]] bool hasCargo() const { return present_; }

    /// Raw GPIO reading (before debounce).
    [[nodiscard]] bool rawReading() const { return raw_; }

    /// Emit type-145 JSON to PiSerial (on-demand query response).
    void emitStatusJson() const;

private:
    uint8_t pin_;
    bool raw_;           // latest GPIO read
    bool present_;       // debounced state
    uint32_t last_change_ms_;  // last state transition
    bool last_raw_;      // previous raw for edge detection
};
