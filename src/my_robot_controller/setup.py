from setuptools import find_packages, setup
import os
from glob import glob

package_name = 'my_robot_controller'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # Include launch files from src/launch/
        (os.path.join('share', package_name, 'launch'), glob('../launch/*.py')),
        # Include Python module files from src/my_robot_controller/
        (os.path.join('share', package_name), glob('*.py')),
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
        ],
    },
)
