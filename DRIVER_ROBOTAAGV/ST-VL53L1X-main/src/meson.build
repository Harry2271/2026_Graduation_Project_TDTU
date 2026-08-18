# ST VL53L1X Time-of-Flight Sensor

vl53l1x_files = files(
	'vl53l1x.cpp'
)

st_vl53l1x = static_library('st_vl53l1x',
	sources: vl53l1x_files,
	dependencies: [
		framework_include_dep,
		framework_host_include_dep
	],
	build_by_default: meson.is_subproject() == false
)

st_vl53l1x_native = static_library('st_vl53l1x_native',
	sources: vl53l1x_files,
	dependencies: [
		framework_include_dep,
		framework_native_include_dep
	],
	native: true,
	build_by_default: meson.is_subproject() == false
)

clangtidy_files += vl53l1x_files
