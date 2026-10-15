// Copyright 2026 Snowflake Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// sdk-constants.js holds the SDK identity and the build-stamped version.
// brum.js imports this file, and esbuild inlines it at bundle time.
// esbuild --define substitutes __BRUM_VERSION__. The typeof guard supplies a fallback value.

export const BRUM_SDK_NAME = 'observe-brum';

export const BRUM_VERSION = (typeof __BRUM_VERSION__ !== 'undefined') ? __BRUM_VERSION__ : 'dev';
