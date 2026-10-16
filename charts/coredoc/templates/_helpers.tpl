{{/*
Expand the name of the chart.
*/}}
{{- define "coredoc.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name (release-scoped, DNS-safe).
*/}}
{{- define "coredoc.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version for the chart label.
*/}}
{{- define "coredoc.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "coredoc.labels" -}}
helm.sh/chart: {{ include "coredoc.chart" . }}
{{ include "coredoc.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "coredoc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "coredoc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Server image reference. A digest, when set, wins over the tag: mirrored and
air-gapped installs commonly require immutable references, and a tag in the
customer's own registry says nothing about which bytes were mirrored.
Otherwise repository:tag, tag defaulting to the chart appVersion.
*/}}
{{- define "coredoc.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end -}}
{{- end }}

{{/*
Neo4j bolt URI for the in-cluster subchart. The subchart's service name is
pinned via neo4j.fullnameOverride (default "neo4j").
*/}}
{{- define "coredoc.neo4jUri" -}}
{{- printf "bolt://%s:7687" (default "neo4j" .Values.neo4j.fullnameOverride) }}
{{- end }}

{{/*
Agent runner names and labels. The runner's selector labels must never match
the server Service's selector (name + instance), or the Service would route
API traffic to runner pods.
*/}}
{{- define "coredoc.agentRunner.fullname" -}}
{{- printf "%s-agent-runner" (include "coredoc.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "coredoc.agentRunner.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-agent-runner" (include "coredoc.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: agent-runner
{{- end }}

{{- define "coredoc.agentRunner.labels" -}}
helm.sh/chart: {{ include "coredoc.chart" . }}
{{ include "coredoc.agentRunner.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Agent runner image: its own reference, never the server's. A digest wins over
the tag; the tag defaults to the chart appVersion.
*/}}
{{- define "coredoc.agentRunner.image" -}}
{{- $image := .Values.agentRunner.image -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $image.repository $image.digest }}
{{- else -}}
{{- printf "%s:%s" $image.repository (default .Chart.AppVersion $image.tag) }}
{{- end -}}
{{- end }}
