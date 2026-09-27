from setuptools import find_packages, setup
import os
from glob import glob

package_name = 'my_robot_controller'
pkg_dir = os.path.dirname(os.path.abspath(__file__))

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # Include launch files from launch/ (relative to package root)
        (os.path.join('share', package_name, 'launch'),
            sorted(glob('launch/*.py'))),
        # Include config files from config/ (nav2, slam, demo zones, etc.)
        (os.path.join('share', package_name, 'config'),
            sorted(glob('config/*.yaml'))),
        # Also install demo_zones.yaml into package root for easy Python access
        (os.path.join('share', package_name, 'config'),
            sorted(glob('config/demo_zones.yaml'))),
        # Include URDF/Xacro files
        (os.path.join('share', package_name, 'urdf'),
            sorted(glob('urdf/*.xacro') + glob('urdf/*.urdf'))),
    ],
    install_requires=['setuptools', 'websockets>=10.0'],
    zip_safe=True,
    maintainer='User',
    maintainer_email='user@todo.todo',
    description='Custom robot controller for mapping and navigation',
    license='TODO: License declaration',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'brain = my_robot_controller.brain_node:main',
            'web_bridge = my_robot_controller.web_bridge:main',
            'map_manager = my_robot_controller.map_manager_node:main',
            'april_tag_node = my_robot_controller.april_tag_node:main',
            'camera_stream = my_robot_controller.camera_stream:main',
            'esp32_telemetry_node = my_robot_controller.esp32_telemetry_node:main',
            'odom = my_robot_controller.odom_node:main',
            'teleop_node = my_robot_controller.teleop_node:main',
            'vision_node = my_robot_controller.vision_node:main',
            'motor_health_node = my_robot_controller.motor_health_node:main',
            'voice_control_node = my_robot_controller.voice_control_node:main',
        ],
    },
)

