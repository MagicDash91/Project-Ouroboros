FROM apache/airflow:3.2.1-python3.12
# dbt runs inside the Airflow worker; pinned to the versions the backend uses.
RUN pip install --no-cache-dir "dbt-core==1.11.*" "dbt-postgres==1.10.*"
