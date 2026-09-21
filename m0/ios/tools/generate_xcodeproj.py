#!/usr/bin/env python3
"""Regenerates FindMyPersonM0.xcodeproj/project.pbxproj (and the shared scheme).

The .xcodeproj is committed, so you never need to run this to use the app. It exists so the
project file is reviewable and reproducible without installing XcodeGen: edit the settings
below, run `python3 tools/generate_xcodeproj.py` from m0/ios, and commit the result.
"""
import hashlib
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PROJ = os.path.join(ROOT, "FindMyPersonM0.xcodeproj")
NAME = "FindMyPersonM0"
# Change the bundle id here OR (easier) in Xcode: target > Signing & Capabilities > Bundle Identifier.
BUNDLE_ID = "dev.findmyperson.m0"
DEPLOYMENT_TARGET = "15.0"

app_sources = sorted(f for f in os.listdir(os.path.join(ROOT, "App")) if f.endswith(".swift"))
lib_sources = sorted(f for f in os.listdir(os.path.join(ROOT, "Sources/CaptureLog")) if f.endswith(".swift"))


def oid(key):
    return hashlib.md5(key.encode()).hexdigest()[:24].upper()


objs = []  # (id, comment, body)


def add(key, comment, body):
    objs.append((oid(key), comment, body))
    return oid(key)


build_files, refs = [], {}
for grp, files in (("App", app_sources), ("CaptureLog", lib_sources)):
    for f in files:
        ref = add(f"ref:{grp}/{f}", f, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{f}"; sourceTree = "<group>";')
        bf = add(f"bf:{grp}/{f}", f"{f} in Sources", f"isa = PBXBuildFile; fileRef = {ref};")
        refs[(grp, f)] = ref
        build_files.append((bf, f))

plist_ref = add("ref:Info.plist", "Info.plist", 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "Info.plist"; sourceTree = "<group>";')
product_ref = add("ref:product", f"{NAME}.app", f'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "{NAME}.app"; sourceTree = BUILT_PRODUCTS_DIR;')

app_group = add("grp:App", "App", "isa = PBXGroup; children = (\n" + "".join(f"\t\t\t\t{refs[('App', f)]} /* {f} */,\n" for f in app_sources) + f"\t\t\t\t{plist_ref} /* Info.plist */,\n\t\t\t); path = App; sourceTree = \"<group>\";")
lib_group = add("grp:Lib", "CaptureLog", "isa = PBXGroup; children = (\n" + "".join(f"\t\t\t\t{refs[('CaptureLog', f)]} /* {f} */,\n" for f in lib_sources) + "\t\t\t); path = Sources/CaptureLog; sourceTree = \"<group>\";")
products_group = add("grp:Products", "Products", f"isa = PBXGroup; children = (\n\t\t\t\t{product_ref} /* {NAME}.app */,\n\t\t\t); name = Products; sourceTree = \"<group>\";")
root_group = add("grp:Root", "Root", f"isa = PBXGroup; children = (\n\t\t\t\t{app_group} /* App */,\n\t\t\t\t{lib_group} /* CaptureLog */,\n\t\t\t\t{products_group} /* Products */,\n\t\t\t); sourceTree = \"<group>\";")

sources_phase = add("phase:sources", "Sources", "isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (\n" + "".join(f"\t\t\t\t{bf} /* {f} in Sources */,\n" for bf, f in build_files) + "\t\t\t); runOnlyForDeploymentPostprocessing = 0;")
frameworks_phase = add("phase:frameworks", "Frameworks", "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (\n\t\t\t); runOnlyForDeploymentPostprocessing = 0;")
resources_phase = add("phase:resources", "Resources", "isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (\n\t\t\t); runOnlyForDeploymentPostprocessing = 0;")


def settings(d):
    return "buildSettings = {\n" + "".join(f"\t\t\t\t{k} = {v};\n" for k, v in sorted(d.items())) + "\t\t\t};"


common = {
    "ALWAYS_SEARCH_USER_PATHS": "NO",
    "CLANG_ENABLE_MODULES": "YES",
    "CLANG_ENABLE_OBJC_ARC": "YES",
    "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
    "IPHONEOS_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET,
    "SDKROOT": "iphoneos",
    "SWIFT_VERSION": "5.0",
}
proj_debug = add("cfg:proj:Debug", "Debug", "isa = XCBuildConfiguration; " + settings({**common, "DEBUG_INFORMATION_FORMAT": "dwarf", "ONLY_ACTIVE_ARCH": "YES", "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG", "SWIFT_OPTIMIZATION_LEVEL": '"-Onone"', "GCC_OPTIMIZATION_LEVEL": "0"}) + " name = Debug;")
proj_release = add("cfg:proj:Release", "Release", "isa = XCBuildConfiguration; " + settings({**common, "DEBUG_INFORMATION_FORMAT": '"dwarf-with-dsym"', "SWIFT_COMPILATION_MODE": "wholemodule", "VALIDATE_PRODUCT": "YES"}) + " name = Release;")
target_common = {
    "ASSETCATALOG_COMPILER_APPICON_NAME": '""',
    "CODE_SIGN_STYLE": "Automatic",
    "CURRENT_PROJECT_VERSION": "1",
    "DEVELOPMENT_TEAM": '""',  # pick your own Personal Team in Xcode > Signing & Capabilities
    "GENERATE_INFOPLIST_FILE": "NO",
    "INFOPLIST_FILE": "App/Info.plist",
    "LD_RUNPATH_SEARCH_PATHS": '"$(inherited) @executable_path/Frameworks"',
    "MARKETING_VERSION": "0.1",
    "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_ID,
    "PRODUCT_NAME": '"$(TARGET_NAME)"',
    "TARGETED_DEVICE_FAMILY": "1",
}
tgt_debug = add("cfg:tgt:Debug", "Debug", "isa = XCBuildConfiguration; " + settings(target_common) + " name = Debug;")
tgt_release = add("cfg:tgt:Release", "Release", "isa = XCBuildConfiguration; " + settings(target_common) + " name = Release;")
proj_cfgs = add("cfglist:proj", f'Build configuration list for PBXProject "{NAME}"', f"isa = XCConfigurationList; buildConfigurations = (\n\t\t\t\t{proj_debug} /* Debug */,\n\t\t\t\t{proj_release} /* Release */,\n\t\t\t); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
tgt_cfgs = add("cfglist:tgt", f'Build configuration list for PBXNativeTarget "{NAME}"', f"isa = XCConfigurationList; buildConfigurations = (\n\t\t\t\t{tgt_debug} /* Debug */,\n\t\t\t\t{tgt_release} /* Release */,\n\t\t\t); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
target = add("target", NAME, f"isa = PBXNativeTarget; buildConfigurationList = {tgt_cfgs}; buildPhases = (\n\t\t\t\t{sources_phase} /* Sources */,\n\t\t\t\t{frameworks_phase} /* Frameworks */,\n\t\t\t\t{resources_phase} /* Resources */,\n\t\t\t); buildRules = (\n\t\t\t); dependencies = (\n\t\t\t); name = {NAME}; productName = {NAME}; productReference = {product_ref}; productType = \"com.apple.product-type.application\";")
project = add("project", "Project object", f'isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1620; LastUpgradeCheck = 1620; TargetAttributes = {{ {target} = {{ CreatedOnToolsVersion = 16.2; }}; }}; }}; buildConfigurationList = {proj_cfgs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (\n\t\t\t\ten,\n\t\t\t\tBase,\n\t\t\t); mainGroup = {root_group}; productRefGroup = {products_group}; projectDirPath = ""; projectRoot = ""; targets = (\n\t\t\t\t{target} /* {NAME} */,\n\t\t\t);')

out = "// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {\n\t};\n\tobjectVersion = 56;\n\tobjects = {\n"
for i, c, b in sorted(objs):
    out += f"\t\t{i} /* {c} */ = {{{b}}};\n"
out += f"\t}};\n\trootObject = {project} /* Project object */;\n}}\n"

os.makedirs(PROJ, exist_ok=True)
with open(os.path.join(PROJ, "project.pbxproj"), "w") as fh:
    fh.write(out)

scheme_dir = os.path.join(PROJ, "xcshareddata", "xcschemes")
os.makedirs(scheme_dir, exist_ok=True)
ref_xml = f'BuildableIdentifier = "primary" BlueprintIdentifier = "{target}" BuildableName = "{NAME}.app" BlueprintName = "{NAME}" ReferencedContainer = "container:{NAME}.xcodeproj"'
scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1620" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference {ref_xml}>
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "NO">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference {ref_xml}>
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
'''
with open(os.path.join(scheme_dir, f"{NAME}.xcscheme"), "w") as fh:
    fh.write(scheme)
print("wrote", PROJ)
