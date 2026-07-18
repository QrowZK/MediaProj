{
  "targets": [
    {
      "target_name": "wasapi_exclusive",
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/wasapi_exclusive.cc"],
          "libraries": ["ole32.lib", "avrt.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
          }
        }, {
          "sources": ["src/stub.c"]
        }]
      ]
    }
  ]
}
