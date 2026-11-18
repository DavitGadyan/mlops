{{/* Labels that select the pods of one component. Call with (dict "root" $ "component" "gateway"). */}}
{{- define "qwen7b.selector" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{- define "qwen7b.labels" -}}
{{ include "qwen7b.selector" . }}
app.kubernetes.io/part-of: qwen7b
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end }}

{{/* The Secret that holds the API key: the user's, or the one this chart creates. */}}
{{- define "qwen7b.apiKeySecret" -}}
{{ .Values.apiKeySecret | default (printf "%s-api-key" .Release.Name) }}
{{- end }}
