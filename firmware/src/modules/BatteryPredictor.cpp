#include "BatteryPredictor.h"
#include <algorithm>

BatteryPredictor::BatteryPredictor()
    : m_last_current_a(0.0f)
    , m_last_update_ms(0)
    , m_total_mah_consumed(0.0f)
    , m_history_index(0)
    , m_history_count(0)
    , m_last_history_update_ms(0)
    , m_dock_distance_m(50.0f)  // Default: assume 50m to dock
{
    m_state.voltage_v = 0.0f;
    m_state.current_a = 0.0f;
    m_state.soc_pct = 100.0f;
    m_state.coulomb_consumed_mah = 0.0f;
    m_state.estimated_range_m = 0.0f;
    m_state.should_return_to_dock = false;

    // Initialize power history
    for (uint8_t i = 0; i < HISTORY_SIZE; i++) {
        m_power_history_w[i] = 0.0f;
    }
}

void BatteryPredictor::begin()
{
    Serial.println("  [BATTERY] Predictive battery manager initialized");
    Serial.printf("            Capacity: %.0f mAh, Return threshold: %.0f%%\n",
                  BATTERY_CAPACITY_MAH, RETURN_THRESHOLD_PCT);
    Serial.printf("            Voltage range: %.1fV (full) -> %.1fV (empty)\n",
                  BATTERY_FULL_V, BATTERY_EMPTY_V);
}

void BatteryPredictor::update(uint32_t now_ms, float voltage_v, float current_a)
{
    m_state.voltage_v = voltage_v;
    m_state.current_a = current_a;

    // First update — initialize timestamp
    if (m_last_update_ms == 0) {
        m_last_update_ms = now_ms;
        m_last_current_a = current_a;
        return;
    }

    // Coulomb counting: integrate current over time
    uint32_t dt_ms = now_ms - m_last_update_ms;
    if (dt_ms > 0) {
        // Average current over interval (trapezoidal integration)
        float avg_current_a = (current_a + m_last_current_a) / 2.0f;

        // Convert to mAh: (A × ms) / 3600000
        float mah_consumed = (avg_current_a * dt_ms) / 3600000.0f;
        m_total_mah_consumed += mah_consumed;

        m_last_update_ms = now_ms;
        m_last_current_a = current_a;
    }

    // Calculate SOC (coulomb counting + voltage correction)
    m_state.soc_pct = calculateSOC(voltage_v, m_total_mah_consumed);
    m_state.coulomb_consumed_mah = m_total_mah_consumed;

    // Update power history (1-minute rolling average)
    float power_w = voltage_v * current_a;
    updatePowerHistory(power_w, now_ms);

    // Estimate range
    m_state.estimated_range_m = estimateRange(m_state.soc_pct);

    // Auto-return decision
    float range_needed_m = m_dock_distance_m + SAFETY_MARGIN_M;
    m_state.should_return_to_dock = (m_state.soc_pct < RETURN_THRESHOLD_PCT) ||
                                     (m_state.estimated_range_m < range_needed_m);
}

void BatteryPredictor::resetCoulombCounter()
{
    m_total_mah_consumed = 0.0f;
    m_state.coulomb_consumed_mah = 0.0f;
    m_state.soc_pct = 100.0f;
    Serial.println("[BATTERY] Coulomb counter reset (fully charged)");
}

float BatteryPredictor::calculateSOC(float voltage_v, float coulombs_mah)
{
    // Hybrid SOC calculation:
    // 1. Coulomb counting: SOC = 100 - (consumed_mah / capacity * 100)
    float soc_coulomb = 100.0f - (coulombs_mah / BATTERY_CAPACITY_MAH * 100.0f);

    // 2. Voltage-based SOC (for drift correction)
    // Linear interpolation between FULL and EMPTY voltage
    float soc_voltage = 0.0f;
    if (voltage_v >= BATTERY_FULL_V) {
        soc_voltage = 100.0f;
    } else if (voltage_v <= BATTERY_EMPTY_V) {
        soc_voltage = 0.0f;
    } else {
        soc_voltage = (voltage_v - BATTERY_EMPTY_V) /
                      (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0f;
    }

    // Weighted average: 70% coulomb counting, 30% voltage
    // (coulomb counting more accurate, voltage corrects drift)
    float soc = soc_coulomb * 0.7f + soc_voltage * 0.3f;

    // Clamp to [0, 100]
    return std::max(0.0f, std::min(100.0f, soc));
}

float BatteryPredictor::estimateRange(float soc_pct)
{
    // Remaining energy (Wh) = capacity × voltage × SOC
    float remaining_wh = (BATTERY_CAPACITY_MAH / 1000.0f) *
                         BATTERY_NOMINAL_V *
                         (soc_pct / 100.0f);

    // Average power consumption from history
    float avg_power_w = getAveragePower();
    if (avg_power_w < 0.1f) {
        // No power history yet or idle → assume conservative 50W
        avg_power_w = 50.0f;
    }

    // Remaining runtime (hours) = energy / power
    float remaining_hours = remaining_wh / avg_power_w;

    // Estimate range: assume robot travels at 0.5 m/s average
    // (conservative — actual cruise is ~1 m/s, but includes stops)
    float estimated_range_m = remaining_hours * 3600.0f * 0.5f;

    return estimated_range_m;
}

void BatteryPredictor::updatePowerHistory(float power_w, uint32_t now_ms)
{
    // Update once per second
    if (m_last_history_update_ms == 0) {
        m_last_history_update_ms = now_ms;
    }

    if (now_ms - m_last_history_update_ms >= 1000) {
        m_power_history_w[m_history_index] = power_w;
        m_history_index = (m_history_index + 1) % HISTORY_SIZE;
        if (m_history_count < HISTORY_SIZE) {
            m_history_count++;
        }
        m_last_history_update_ms = now_ms;
    }
}

float BatteryPredictor::getAveragePower() const
{
    if (m_history_count == 0) {
        return 0.0f;
    }

    float sum = 0.0f;
    for (uint8_t i = 0; i < m_history_count; i++) {
        sum += m_power_history_w[i];
    }
    return sum / m_history_count;
}
