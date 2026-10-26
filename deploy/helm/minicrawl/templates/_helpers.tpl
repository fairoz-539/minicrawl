{{- define "minicrawl.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "minicrawl.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "minicrawl.labels" -}}
app.kubernetes.io/name: {{ include "minicrawl.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "minicrawl.selector" -}}
app.kubernetes.io/name: {{ include "minicrawl.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "minicrawl.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "minicrawl.secretName" -}}
{{- .Values.existingSecret | default (include "minicrawl.fullname" .) -}}
{{- end -}}

{{/* Environment shared by API and worker pods. */}}
{{- define "minicrawl.env" -}}
- name: STORAGE
  value: postgres
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "minicrawl.secretName" . }}, key: DATABASE_URL } }
- name: API_KEYS
  valueFrom: { secretKeyRef: { name: {{ include "minicrawl.secretName" . }}, key: API_KEYS } }
- name: ANTHROPIC_API_KEY
  valueFrom: { secretKeyRef: { name: {{ include "minicrawl.secretName" . }}, key: ANTHROPIC_API_KEY, optional: true } }
{{- if .Values.searxng.enabled }}
- name: SEARXNG_ENDPOINT
  value: http://{{ include "minicrawl.fullname" . }}-searxng:8080
{{- end }}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{/* Probes, volumes and security settings shared by API and worker pods. */}}
{{- define "minicrawl.podCommon" -}}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
volumes:
  - name: dshm
    emptyDir: { medium: Memory, sizeLimit: {{ .Values.shmSize }} }
{{- end -}}

{{- define "minicrawl.containerCommon" -}}
image: {{ include "minicrawl.image" . }}
imagePullPolicy: {{ .Values.image.pullPolicy }}
ports:
  - { name: http, containerPort: 3002 }
volumeMounts:
  - { name: dshm, mountPath: /dev/shm }
readinessProbe:
  httpGet: { path: /health, port: http }
  periodSeconds: 10
livenessProbe:
  httpGet: { path: /health, port: http }
  initialDelaySeconds: 30
  periodSeconds: 20
  failureThreshold: 6
securityContext:
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
{{- end -}}
