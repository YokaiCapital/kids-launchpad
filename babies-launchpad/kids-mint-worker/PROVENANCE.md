# Source provenance

The `vendor/` directory is the minimum 24-module transitive source closure of the existing, user-authorized internal generator and encrypted inventory implementation. It was copied rather than reimplemented. Packaging changes localize imports, specialize the four-character suffix to `kids`, and replace internal branding and storage namespaces with KIDS-specific names. No source maps, private deployment records, runtime inventories, wallet keys, or unrelated application files are included.

No copyright, license header, or package-level license file was present in these internal source modules. The project owner has authorized inclusion under the repository's source-available noncommercial terms. This provenance record does not establish ownership or override third-party rights.

Third-party dependencies are installed from the lockfile rather than copied here. Their original license notices must remain with any redistributed dependency installation or container image. Do not delete dependency license files during packaging.
