# Bootstrap-only copy of src/Project1.
# Copies the sample project into the build tree ONLY when the destination
# does not already exist (e.g. a fresh clone). Never overwrites an existing
# build/Project1 — that folder may be the user's own non-public project.
# Usage:
#   cmake -DSRC_DIR=<abs path to src/Project1>
#         -DDST_DIR=<abs path to build/Project1>
#         -P copy_project1.cmake

if(EXISTS "${SRC_DIR}" AND NOT EXISTS "${DST_DIR}")
  get_filename_component(_dest_root "${DST_DIR}" DIRECTORY)
  file(COPY "${SRC_DIR}" DESTINATION "${_dest_root}")
  message(STATUS "Project1 copied from src/Project1 to ${DST_DIR} (first build only)")
endif()