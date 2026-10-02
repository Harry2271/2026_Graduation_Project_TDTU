#pragma once

#include <Arduino.h>

// ============================================================
// BatteryPredictor — Predictive battery management
// ============================================================
// Features:
//   1. Coulomb counting (tích phân dòng điện) → SOC chính xác
//   2. Range estimation (còn chạy được bao xa)
//   3. Auto-return trigger (cảnh báo Pi khi cần về sạc)
// ============================================================

struct BatteryState {
    float voltage_v;
    float current_a;
    float soc_pct;              // State of charge (0-100%)
    float coulomb_consumed_mah; // Total mAh consumed since last full charge
    float estimated_range_m;    // Meters remaining at current consumption
    bool should_return_to_dock; // True when must return to charging
};

class BatteryPredictor {
public:
    BatteryPredictor();

    void begin();

    // Update with latest INA226 readings
    void update(uint32_t now_ms, float voltage_v, float current_a);

    // Reset coulomb counter (call when fully charged)
    void resetCoulombCounter();

    // Get current state
    const BatteryState& getState() const { return m_state; }
    float getSOC() const { return m_state.soc_pct; }
    float getEstimatedRange() const { return m_state.estimated_range_m; }
    bool shouldReturnToDock() const { return m_state.should_return_to_dock; }

    // Set dock location for distance calculation
    void setDockDistance(float distance_m) { m_dock_distance_m = distance_m; }

private:
    BatteryState m_state;

    // Coulomb counting
    float m_last_current_a;
    uint32_t m_last_update_ms;
    float m_total_mah_consumed;

    // Power history for range estimation (1-minute rolling average)
    static constexpr uint8_t HISTORY_SIZE = 60;
    float m_power_history_w[HISTORY_SIZE];
    uint8_t m_history_index;
    uint32_t m_history_count;
    uint32_t m_last_history_update_ms;

    // Battery capacity
    static constexpr float BATTERY_CAPACITY_MAH = 7000.0f;  // 3S3P 18650 (2350mAh × 3)
    static constexpr float BATTERY_NOMINAL_V = 11.1f;       // 3S nominal
    static constexpr float BATTERY_FULL_V = 12.6f;          // 3S fully charged
    static constexpr float BATTERY_EMPTY_V = 9.0f;          // 3S empty (3.0V/cell)

    // Auto-return thresholds
    static constexpr float RETURN_THRESHOLD_PCT = 25.0f;    // Return at 25% SOC
    static constexpr float SAFETY_MARGIN_M = 10.0f;         // 10m safety margin

    // Distance to dock (updated by brain_node via Pi command)
    float m_dock_distance_m;

    // Calculate SOC from coulomb counting + voltage
    float calculateSOC(float voltage_v, float coulombs_mah);

    // Estimate range from average power consumption
    float estimateRange(float soc_pct);

    // Update power history (1-minute rolling average)
    void updatePowerHistory(float power_w, uint32_t now_ms);

    // Get average power from history
    float getAveragePower() const;
};
