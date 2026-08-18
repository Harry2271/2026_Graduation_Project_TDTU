"""Unit tests for the Esp32Bridge interface.

The tests use FakeEsp32Bridge which records every command sent and
lets us inject responses for assertions.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from my_robot_controller.esp32_bridge import FakeEsp32Bridge, RealEsp32Bridge


@pytest.mark.asyncio
async def test_fake_bridge_records_move_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.move(vx=100, vy=0, omega=0)
    await bridge.disconnect()

    sent = bridge.sent_commands()
    assert sent == [{'cmd': 'move', 'vx': 100, 'vy': 0, 'omega': 0}]


@pytest.mark.asyncio
async def test_fake_bridge_stop_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.stop()
    await bridge.disconnect()

    assert bridge.sent_commands() == [{'cmd': 'stop'}]


@pytest.mark.asyncio
async def test_fake_bridge_e_stop_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.e_stop()
    await bridge.disconnect()

    assert bridge.sent_commands() == [{'cmd': 'e_stop'}]


@pytest.mark.asyncio
async def test_fake_bridge_heartbeat_runs_at_interval() -> None:
    bridge = FakeEsp32Bridge(heartbeat_interval_s=0.01)
    await bridge.connect()
    # Sleep long enough for at least 5 heartbeat cycles; assertion is loose
    # (>= 2) so it stays stable across platforms with different clock
    # resolution and asyncio scheduling overhead.
    await asyncio.sleep(0.1)
    await bridge.disconnect()

    sent = bridge.sent_commands()
    heartbeat_count = sum(1 for cmd in sent if cmd == {'cmd': 'heartbeat'})
    assert heartbeat_count >= 2, f'expected at least 2 heartbeats, got {heartbeat_count}'


@pytest.mark.asyncio
async def test_fake_bridge_injects_status_event() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()

    received: list[dict] = []
    bridge.on_status_update = lambda data: received.append(data)

    bridge.inject_status({'uptime_ms': 1234, 'mode': 'NAV', 'e_stop': False})
    await asyncio.sleep(0.01)

    assert received == [{'uptime_ms': 1234, 'mode': 'NAV', 'e_stop': False}]
    await bridge.disconnect()


@pytest.mark.asyncio
async def test_fake_bridge_serializes_concurrent_writes() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()

    await asyncio.gather(*[bridge.move(i, 0, 0) for i in range(10)])
    await bridge.disconnect()

    sent = bridge.sent_commands()
    assert len(sent) == 10
    assert [s['vx'] for s in sent] == list(range(10))


@pytest.mark.asyncio
async def test_real_bridge_encodes_move_as_json_line() -> None:
    writer = MagicMock()
    writer.write = MagicMock()
    writer.drain = AsyncMock()
    reader = MagicMock()
    reader.readline = AsyncMock(return_value=b'{"type":128,"data":{"cmd":"move"}}\n')

    bridge = RealEsp32Bridge(writer=writer, reader=reader)
    await bridge.move(vx=100, vy=0, omega=0)

    writer.write.assert_called_once()
    written_bytes = writer.write.call_args[0][0]
    assert written_bytes.endswith(b'\n')
    payload = json.loads(written_bytes.decode('utf-8').strip())
    assert payload == {'cmd': 'move', 'vx': 100, 'vy': 0, 'omega': 0}


def test_real_bridge_handles_flat_type_131_status_frame() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_status_update = received.append

    bridge._handle_line(
        b'{"ts":14844896,"type":131,"mode":"AUTO_ROAM",'
        b'"estop":false,"max_pct":100,"nav":[0,0,0],'
        b'"motors":[{"t":30,"r":0}],"ir":[false],'
        b'"st":{"imu":false,"pwr":false,"sharp":22,"obs":false,'
        b'"tof_mm":9999,"cyl":"idle"}}\n'
    )

    assert received == [
        {
            'ts': 14844896,
            'type': 131,
            'mode': 'AUTO_ROAM',
            'estop': False,
            'max_pct': 100,
            'nav': [0, 0, 0],
            'motors': [{'t': 30, 'r': 0}],
            'ir': [False],
            'st': {
                'imu': False,
                'pwr': False,
                'sharp': 22,
                'obs': False,
                'tof_mm': 9999,
                'cyl': 'idle',
            },
        }
    ]


def test_real_bridge_handles_envelope_type_131_status_frame() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_status_update = received.append
    payload = {'mode': 'AUTO_ROAM', 'e_stop': False, 'max_pct': 100}

    bridge._handle_line(
        json.dumps({'type': 131, 'data': payload}).encode('utf-8') + b'\n'
    )

    assert received == [payload]


def test_real_bridge_caches_enveloped_numeric_unload_state() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_unload_state = received.append
    payload = {
        'state': 7,
        'state_name': 'complete',
        'tag_id': 2,
        'target_mm': 300,
        'current_mm': 298,
        'error': False,
        'error_code': 0,
        'error_name': 'none',
    }

    bridge._handle_line(json.dumps({'type': 140, 'data': payload}).encode('utf-8'))

    assert received == [payload]
    assert bridge.last_unload_state == payload


def test_real_bridge_caches_unload_error() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    payload = {
        'state': 0,
        'state_name': 'idle',
        'error': True,
        'error_code': 3,
        'error_name': 'imu_unavailable',
    }

    bridge._handle_line(json.dumps({'type': 140, 'data': payload}).encode('utf-8'))

    assert bridge.last_unload_state['error'] is True
    assert bridge.last_unload_state['error_name'] == 'imu_unavailable'


def test_real_bridge_preserves_complete_across_immediate_idle_frame() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_unload_state = received.append
    complete = {'state': 7, 'state_name': 'complete', 'error': False}
    idle = {'state': 0, 'state_name': 'idle', 'error': False}

    bridge._handle_line(json.dumps({'type': 140, 'data': complete}).encode('utf-8'))
    bridge._handle_line(json.dumps({'type': 140, 'data': idle}).encode('utf-8'))

    assert received == [complete, idle]
    assert bridge.last_unload_state == complete


@pytest.mark.asyncio
async def test_real_bridge_new_dock_clears_prior_terminal_result() -> None:
    writer = MagicMock()
    writer.drain = AsyncMock()
    bridge = RealEsp32Bridge(writer=writer, reader=MagicMock())
    bridge._last_unload_state = {'state': 7, 'state_name': 'complete', 'error': False}

    await bridge.begin_dock(tag_id=2, target_distance_mm=300, operation_id='op-2')

    assert bridge.last_unload_state == {}
    sent = json.loads(writer.write.call_args[0][0].decode('utf-8'))
    assert sent['cmd'] == 'begin_dock'
    assert sent['operation_id'] == 'op-2'


def test_real_bridge_normalizes_firmware_type_133_accessors() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_power = received.append
    payload = {
        'voltage_v': 20.1,
        'current_a': 0.45,
        'power_w': 9.0,
        'battery_pct': 92,
        'battery_status': 'ok',
        'noload': False,
    }

    bridge._handle_line(json.dumps({'type': 133, 'data': payload}).encode('utf-8'))

    assert received == [payload]
    assert bridge.last_power() == payload
    assert bridge.battery_voltage() == pytest.approx(20.1)
    assert bridge.battery_current() == pytest.approx(0.45)
    assert bridge.battery_pct() == pytest.approx(0.92)


def test_real_bridge_accepts_valid_zero_percent_battery() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    bridge._handle_line(
        b'{"type":133,"data":{"voltage_v":12.0,"current_a":0.0,'
        b'"battery_pct":0,"battery_status":"critical","noload":false}}'
    )

    assert bridge.battery_voltage() == pytest.approx(12.0)
    assert bridge.battery_pct() == 0.0


def test_real_bridge_treats_noload_power_as_unavailable() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_power = received.append
    payload = {
        'voltage_v': 0.0,
        'current_a': 0.0,
        'power_w': 0.0,
        'battery_pct': 0,
        'battery_status': 'unknown',
        'noload': True,
    }

    bridge._handle_line(json.dumps({'type': 133, 'data': payload}).encode('utf-8'))

    assert received == [payload]
    assert bridge.last_power() == payload
    assert bridge.battery_voltage() is None
    assert bridge.battery_current() is None
    assert bridge.battery_pct() is None


def test_real_bridge_ignores_stale_power_accessors() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    bridge._last_power = {
        'voltage_v': 20.1,
        'current_a': 0.45,
        'battery_pct': 92,
        'battery_status': 'ok',
        'noload': False,
    }
    bridge._last_power_ms = -1.0

    assert bridge.battery_voltage() is None
    assert bridge.battery_current() is None
    assert bridge.battery_pct() is None


@pytest.mark.parametrize(
    ('frame_type', 'callback_name', 'payload'),
    [
        (128, 'on_ack', {'status': 'accepted', 'cmd': 'stop'}),
        (132, 'on_move_ack', {'seq': 4, 'status': 'accepted'}),
        (135, 'on_ir', {'left': True, 'right': False}),
        (136, 'on_sharp', {'distance_cm': 18, 'too_close': True}),
        (138, 'on_tof', {'distance_mm': 300, 'present': True}),
        (139, 'on_cylinder', {'state': 'retracting', 'moving': True}),
        (142, 'on_health', {'modules': [{'id': 'imu', 'state': 'ONLINE'}]}),
    ],
)
def test_real_bridge_forwards_operational_json_frames(
    frame_type: int, callback_name: str, payload: dict,
) -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    setattr(bridge, callback_name, received.append)

    bridge._handle_line(json.dumps({'type': frame_type, 'data': payload}).encode('utf-8'))

    assert received == [payload]


def test_real_bridge_preserves_structured_firmware_error() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    structured: list[dict] = []
    text_errors: list[str] = []
    bridge.on_firmware_error = structured.append
    bridge.on_error = text_errors.append
    payload = {
        'code': 'imu_uncalibrated',
        'error': 'Dock preflight rejected',
        'severity': 'error',
    }

    bridge._handle_line(json.dumps({'type': 129, 'data': payload}).encode('utf-8'))

    assert structured == [payload]
    assert text_errors == ['Dock preflight rejected']
    assert bridge.last_error_data == payload


def test_real_bridge_accepts_legacy_estop_status_field() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    e_stop_events: list[bool] = []
    bridge.on_e_stop = lambda: e_stop_events.append(True)

    bridge._handle_line(b'{"type":131,"estop":true}')

    assert e_stop_events == [True]


def test_real_bridge_preserves_imu_safety_payload() -> None:
    bridge = RealEsp32Bridge(writer=MagicMock(), reader=MagicMock())
    received: list[dict] = []
    bridge.on_imu = received.append
    payload = {
        'heading': 12.5,
        'q': [1.0, 0.0, 0.0, 0.0],
        'accel': [0.1, 0.0, 0.0],
        'gyro': [0.0, 0.0, 0.2],
        'safety': {
            'config_rev': 1,
            'enforcement': False,
            'sample_valid': True,
            'tilt_deg': 2.0,
            'linear_accel_mps2': 0.1,
            'gyro_dps': 0.2,
            'event': 'none',
        },
    }

    bridge._handle_line(
        json.dumps({'type': 134, 'data': payload}).encode('utf-8')
    )

    assert received == [payload]
    assert received[0]['safety']['enforcement'] is False
